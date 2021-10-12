# pc-stats-nodejs

This is a quick and dirty app to record stats from your windows pc and push them to influx db.

## Getting started

1. Install open hardware monitor https://openhardwaremonitor.org/
   - make sure to set it to `Run on Windows Startup`
2. Install Node.js https://nodejs.org/en/download/
3. Install PM2
   - open a new powershell window and run `npm install -g pm2`
4. Create a free influxdb cloud account https://cloud2.influxdata.com/signup
5. Create a free grafana cloud account https://grafana.com/get/
6. Download this repo and extract it to a folder on your computer
7. In the repo folder, copy `.env.example` as `.env`
8. Update `INFLUX_ORG` in the `.env` file to match the email you used for the influx db account
9. Update `INFLUX_TAG_HOSTNAME` to be anything you like that represents your pc
10. Open a powershell window and navigate into the repo folder and run `npm i`

## Configuring Influx

First, go to `Data > Buckets`, you should see a couple including one that they make for you by default. Ignore those starting with `_`, you care about the other one with 30 days retention. Copy the name of the bucket, and save that in the `.env` as `INFLUX_BUCKET`.

Next go to `Data > API Tokens`, click the button on the right to `Generate API Token > Read/Write API Token`, and a popup will appear. Set a description, under both `Read` and `Write` select your bucket, then click `Save`. Your new token should appear in a list, click the name and you should see a long jumbled string at the top, this is your token. Click `Copy to Clipboard` and store this in your `.env` file as the `INFLUX_TOKEN`.

## Configuring PM2

Our goal here is to have the script startup with window automatically, so first we need to tell PM2 where the script is.

- In a new powershell window, navigate into the repo folder that you downloaded earlier
- run `pm2 start index.js --name pc-stats` to start the app
- next run `pm2 save` which will record this config
- now press the windows key and `r` to open the run dialog
- enter `shell:startup` and click `Ok` and your startup folder will open
- also open a new explorer window and browse to the repo folder
- right-click and drag the `startup.ps1` file to the startup folder and choose `Create shortcuts here`
- Right click and edit the new shortcut, the target will look like 
```
C:\dev\projects\pc-stats-nodejs\startup.ps1
```
but you need to edit it to be 
```
%SystemRoot%\system32\WindowsPowerShell\v1.0\powershell.exe -File "C:\dev\projects\iki-stats-nodejs\startup.ps1"
```
taking care to wrap the original file name in double quotes `"`

And that should be it... hopefully! You can try restarting the pc and seeing if it worked :D

## Configuring Grafana

Now your script is running, you should be seeing data being collected in your influx db bucket. You can see this if you go to `Explore` in the influx dashboard. To have a little preview, in the blocks at the bottom, the one with filter at the top, it should have `_measurement` then just select `cpu` and `gpu`. A new filter block will open, tick `load`, `power`, and `temp`, then click submit. That should hopefully show you some sort of graph!

Now, to be a bit more secure, we are going to create a new read-only API token in influx, so just like before, go to `Data > API Tokens`, click the button on the right to `Generate API Token > Read/Write API Token`, and a popup will appear. Set a description, under **only** `Read` select your bucket, then click `Save`. Click `Copy to Clipboard` and store this somewhere, you'll be using this in Grafana.

Ok so now login to Grafana, go to `Configuration > Data sources` and click the `Add data source` button. At the top of the list is a filter field, type `influx` in there and choose the `InfluxDB` option. Set the query language as `Flux`, url will be something like `https://eu-central-1-1.aws.cloud2.influxdata.com`, set access as `Browser`. Leave both auth options unchecked. Under InfluxDB details, these will be similar to those in your `.env`. Finish with `Save & test`

Next you'll be creating a new dashboard, and you'll see an option to `Add panel`, click to `Add an empty panel`. It should pick the influx data source in the bottom panel, otherwise select it from the drop down. In the query block at the bottom, enter in the influx query you want... a few examples are below. Remember you can have multiple graphs at the same time in grafana, and set your time window at the top right. 

Everything (replace "pc-stats-nodejs" with your bucket name):

```
from(bucket: "pc-stats-nodejs")
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r["_measurement"] == "cpu" or r["_measurement"] == "gpu" or r["type"] == "process")
  |> filter(fn: (r) => r["_field"] == "load" or r["_field"] == "power" or r["_field"] == "temp" or r["_field"] == "cpu" or r["_field"] == "ram")
  |> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
  |> yield(name: "mean")
```

This is just the cpu stats (replace "pc-stats-nodejs" with your bucket name):

```
from(bucket: "pc-stats-nodejs")
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r["_measurement"] == "cpu")
  |> filter(fn: (r) => r["_field"] == "load" or r["_field"] == "power" or r["_field"] == "temp" or r["_field"] == "fan")
  |> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
  |> yield(name: "mean")
```

And this is the gpu stats (replace "pc-stats-nodejs" with your bucket name):

```
from(bucket: "pc-stats-nodejs")
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r["_measurement"] == "gpu")
  |> filter(fn: (r) => r["_field"] == "load" or r["_field"] == "power" or r["_field"] == "temp" or r["_field"] == "fan")
  |> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
  |> yield(name: "mean")
```

And this is just the active processes:

```
from(bucket: "iki-pc-snek")
  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)
  |> filter(fn: (r) => r["type"] == "process")
  |> filter(fn: (r) => r["_field"] == "cpu" or r["_field"] == "ram")
  |> aggregateWindow(every: v.windowPeriod, fn: mean, createEmpty: false)
  |> yield(name: "mean")
```

## Bonus (Removed because of stupid uws in github issues)

This app also has a little websockets webserver baked in that will respond to requests with a little subset of the last data recorded... I am using this for a mini oled arduino dashboard - i'll post that as a separate project.
