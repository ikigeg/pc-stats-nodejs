require('dotenv').config();

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { InfluxDB, Point } = require('@influxdata/influxdb-client');
// const uWS = require('uWebSockets.js');
const slugify = require('slugify');

const { INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET, INFLUX_TAG_HOSTNAME, INFLUX_WRITE_ENABLED } = process.env;

const client = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN });
const writeApi = client.getWriteApi(INFLUX_ORG, INFLUX_BUCKET);
writeApi.useDefaultTags({ host: INFLUX_TAG_HOSTNAME })

const sysStatsFields = 'Parent, Name, SensorType, Value, Max, Min, Identifier';
const sysStatsWql = 'select ' + sysStatsFields + ' from Sensor ' +
  'where (Parent = "/intelcpu/0" or Parent = "/nvidiagpu/0") ' +
  'and (Name = "CPU Total" or Name = "CPU Package" or Name = "GPU Power" or Name = "GPU Core") ' +
  'and (SensorType = "Load" or SensorType = "Temperature" or SensorType = "Power")';
const sysStatsQuery = `get-wmiobject -namespace root\\OpenHardwareMonitor -query '${sysStatsWql}' | select-object ${sysStatsFields}`;

const processesQuery = 'Get-WmiObject Win32_PerfFormattedData_PerfProc_Process' + 
'| where-object{ $_.Name -ne "_Total" -and $_.Name -ne "Idle"}' +
'| Sort-Object PercentProcessorTime -Descending' +
'| select -First 1' +
'| select-object Name,IDProcess,PercentProcessorTime';
const processNameQuery = pid => `get-process | where-object {$_.ID -eq "${pid}"} | select-object Name`;

async function getJsonFromCmd(cmd, opts = { shell: 'powershell.exe', windowsHide: true }) {
  const result = await execAsync(cmd + '| ConvertTo-Json  -Compress', opts);
  return JSON.parse(result.stdout);
}

const dataPoints = {};
let sysStats = {};
let hasWritten = false;

const totalDataPoints = 10;
const splitStats = stats => {
  for (const [key, value] of Object.entries(stats)) {
    if (!dataPoints[key]) {
      dataPoints[key] = [];
    } else if (dataPoints[key].length > totalDataPoints) {
      dataPoints[key].shift();
    } 
    dataPoints[key].push(value)
  };

  if (!hasWritten) {
    hasWritten = true;
  }
}

function createPoint(measurement, usage) {
  const point = new Point(measurement)
  for (const key of Object.keys(usage)) {
    point.floatField(key, usage[key])
  }
  return point
}

let lastProcess = '';
const writeProcessUsage = (processName) => {
  if (lastProcess === '') {
    writeApi.writePoint(new Point(processName).tag('type', 'process').floatField('value', 0));
  } else if (lastProcess !== processName) {
    writeApi.writePoint(new Point(lastProcess).tag('type', 'process').floatField('value', 0));
    writeApi.writePoint(new Point(processName).tag('type', 'process').floatField('value', 0));
  }
  writeApi.writePoint(new Point(processName).tag('type', 'process').floatField('value', 1));

  lastProcess = processName;
}

const getStats = async () => {
  let Name;

  try {
    const date = new Date();
    const topProcess = await getJsonFromCmd(processesQuery);
    ({ Name } = await getJsonFromCmd(processNameQuery(topProcess.IDProcess)));
    const sysStatsRaw = await getJsonFromCmd(sysStatsQuery);
    sysStats = sysStatsRaw.reduce((acc, cv) => {
      const type = cv.Parent.includes('intelcpu') ? 'cpu' : 'gpu';
      const prop = cv.SensorType.substr(0, 4);
      const key = `${type}${prop}`;
      return {
        ...acc,
        [`${key}Val`]: parseFloat(cv.Value.toFixed(2)),
        [`${key}Max`]: parseFloat(cv.Max.toFixed(2)), 
      }
    }, {
      topProcessName: Name,
      topProcessPid: topProcess.IDProcess,
      dateTime: date.toJSON(),
    });
  } catch (error) {
    console.log('Error reading stats from WMI - check Open Hardware Monitor is running', error);
  }

  try {
    if (INFLUX_WRITE_ENABLED) {
      writeApi.writePoint(createPoint('gpu', {
        temp: sysStats.gpuTempVal,
        power: sysStats.gpuPoweVal,
        load: sysStats.gpuLoadVal,
      }));
      writeApi.writePoint(createPoint('cpu', {
        temp: sysStats.cpuTempVal,
        power: sysStats.cpuPoweVal,
        load: sysStats.cpuLoadVal,
      }));

      writeProcessUsage(slugify(Name, { strict: true, lower: true }));
    }
  } catch (error) {
    console.log('Error sending stats to influx', error);
  }

  if (!hasWritten) {
    console.log('Successfully did a thing, yay!', date);
  }

  try {
    splitStats(sysStats);
  } catch (err) {
    console.log('Error splitting the stats', error);
  }
  
}

let timerId = setTimeout(async function tick() {
  await getStats();
  timerId = setTimeout(tick, 4000);
}, 2000);

// const app = uWS.App().ws('/*', { 
//   compression: uWS.SHARED_COMPRESSOR,
//   maxPayloadLength: 16 * 1024 * 1024,
//   idleTimeout: 12,
//   open: (ws) => {
//     console.log('A WebSocket connected!');
//   },
//   message: (ws, message, isBinary) => {
//     /* Ok is false if backpressure was built up, wait for drain */
//     let ok = ws.send(JSON.stringify({ sysStats, dataPoints }), false);
//   },
//   drain: (ws) => {
//     console.log('WebSocket backpressure: ' + ws.getBufferedAmount());
//   },
//   close: (ws, code, message) => {
//     console.log('WebSocket closed');
//   }
// });
// app.listen(9001, (listenSocket) => {
//   if (listenSocket) {
//     console.log('Listening to port 9001');
//   }
// });

async function onShutdown() {
  clearInterval(timerId)
  try {
    await writeApi.close()
  } catch (error) {
    console.error('ERROR: Application monitoring', error)
  }
  // eslint-disable-next-line no-process-exit
  process.exit(0)
}
process.on('SIGINT', onShutdown)
process.on('SIGTERM', onShutdown)
process.on('SIGUSR2', onShutdown)
