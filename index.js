require('dotenv').config();

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { InfluxDB, Point } = require('@influxdata/influxdb-client');
// const uWS = require('uWebSockets.js');
const slugify = require('slugify');

const { INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET, INFLUX_TAG_HOSTNAME, INFLUX_WRITE_ENABLED } = process.env;
const STATUS = {
  NEW: 'new',
  EXISTS: 'exists',
  RIP: 'rip',
};

const client = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN });
const writeApi = client.getWriteApi(INFLUX_ORG, INFLUX_BUCKET);
writeApi.useDefaultTags({ host: INFLUX_TAG_HOSTNAME })

const sysStatsFields = 'Parent, Name, SensorType, Value, Max, Min, Identifier';
const sysNames = ['CPU Total', 'CPU Package', 'GPU Power', 'GPU Core', 'GPU Memory Used', 'GPU Fan', 'Used Memory', 'Fan Control #1'];
const sysSensorTypes = ['Load', 'Temperature', 'Control', 'Power', 'Data'];
const sysStatsWql = 'select ' + sysStatsFields + ' from Sensor ' +
  'where (' + sysNames.map(n => `Name = "${n}"`).join(' or ') + ') ' +
  'and (' + sysSensorTypes.map(t => `SensorType = "${t}"`).join(' or ') + ')';
const sysStatsQuery = `get-wmiobject -namespace root\\OpenHardwareMonitor -query '${sysStatsWql}' | select-object ${sysStatsFields}`;

const totalProcessorsQuery = `get-wmiobject -query 'select NumberOfLogicalProcessors from Win32_ComputerSystem' | select-object NumberOfLogicalProcessors`;
const processesQueryV2 = '(Get-Counter "\\Process($Processname*)\\% Processor Time").CounterSamples ' +
'| where-object{ $_.CookedValue -gt 0 -and $_.InstanceName -ne "Idle" -and $_.InstanceName -ne "_total"}' +
'| select-object InstanceName,CookedValue';

async function getJsonFromCmd(cmd, opts = { shell: 'powershell.exe', windowsHide: true }) {
  const result = await execAsync(cmd + '| ConvertTo-Json  -Compress', opts);
  return JSON.parse(result.stdout);
}

const totalDataPoints = 10;
const dataPoints = {};
let hasWritten = false;
let date;
let sysStats = {};
let totalProcessors;
let lastProcesses = [];
let processorActivity = {};
let topProcessName = '';

const splitStats = stats => {
  for (const [key, value] of Object.entries(stats)) {
    if (!dataPoints[key]) {
      dataPoints[key] = [];
    } else if (dataPoints[key].length > totalDataPoints) {
      dataPoints[key].shift();
    } 
    dataPoints[key].push(value)
  };
}

function createPoint(measurement, usage, type) {
  const point = new Point(measurement)
  for (const key of Object.keys(usage)) {
    point.floatField(key, usage[key])
  }
  if (type) {
    point.tag('type', type);
  }
  return point;
}

const writeProcessUsage = (name, { status, ...data }) => {
  if (status === STATUS.NEW) {
    writeApi.writePoint(createPoint(name, { cpu: 0, ram: 0 }, 'process'));
  }
  writeApi.writePoint(createPoint(name, data, 'process'));
}

const getStats = async () => {
  date = new Date();

  // Get total number of effective processors (this reflects number of cores)
  if (!totalProcessors) {
    try {
      const { NumberOfLogicalProcessors = 1 } = await getJsonFromCmd(totalProcessorsQuery);
      totalProcessors = NumberOfLogicalProcessors;
    } catch (error) {
      console.log('Unable to determine number of logical processors', error);
    }
  }

  // Take a mini sample of processor activity and process the results
  try {
    const processorActivityJson = await getJsonFromCmd(processesQueryV2);
    let topProcess = '';
    processorActivity = processorActivityJson.reduce((acc, cv) => {
      const slugifiedName = slugify(cv.InstanceName, { strict: true, lower: true });
      const cookedValueDividedByProcessors = parseFloat((cv.CookedValue / totalProcessors).toFixed(2));

      topProcess = topProcess && acc[topProcess].cpu >= cookedValueDividedByProcessors ? topProcess : slugifiedName;

      return {
        ...acc,
        [slugifiedName]: {
          cpu: cookedValueDividedByProcessors,
          ram: 0, // TODO
          status: lastProcesses.includes(slugifiedName) ? STATUS.EXISTS : STATUS.NEW
        },
      };
    }, {});
    
    const currentProcesses = Object.keys(processorActivity);
    lastProcesses.forEach(p => {
      if (!currentProcesses.includes(p)) {
        processorActivity[p] = { cpu: 0, ram: 0, status: STATUS.RIP };
      }
    });

    lastProcesses = currentProcesses;
    topProcessName = topProcess;
  } catch (error) {
    console.log('Unable to fetch processor activity', error);
  }

  // Get system stats
  try {
    const sysStatsRaw = await getJsonFromCmd(sysStatsQuery);

    sysStats = sysStatsRaw.reduce((acc, cv) => {
      const type = cv.Parent === '/ram' ? 'ram' : cv.Name.toLowerCase().substr(0, 3);
      const prop = cv.SensorType.substr(0, 4);
      const key = `${type}${prop}`;
      return {
        ...acc,
        [`${key}Val`]: parseFloat(cv.Value.toFixed(2)),
        [`${key}Max`]: parseFloat(cv.Max.toFixed(2)), 
      }
    }, {
      topProcessName,
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
        fan: sysStats.gpuContVal,
      }));
      writeApi.writePoint(createPoint('cpu', {
        temp: sysStats.cpuTempVal,
        power: sysStats.cpuPoweVal,
        load: sysStats.cpuLoadVal,
        fan: sysStats.fanContVal
      }));
      writeApi.writePoint(createPoint('ram', {
        used: sysStats.ramDataVal,
      }));

      for (const [name, data] of Object.entries(processorActivity)) {
        writeProcessUsage(name, data);
      }
    }
  } catch (error) {
    console.log('Error sending stats to influx', error);
  }

  try {
    splitStats(sysStats);
  } catch (err) {
    console.log('Error splitting the stats', error);
  }

  if (!hasWritten) {
    console.log('Successfully did a thing, yay!', date);
    hasWritten = true;
  }
}

let timerId = setTimeout(async function tick() {
  await getStats();
  timerId = setTimeout(tick, 5000);
}, 1000);

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
