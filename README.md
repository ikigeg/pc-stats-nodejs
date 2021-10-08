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
- run `pm2 index.js --name pc-stats` to start the app
- next run `pm2 save` which will record this config
- now press the windows key and `r` to open the run dialog
- enter `shell:startup` and click `Ok` and your startup folder will open
- also open a new explorer window and browse to the repo folder
- right-click and drag the `startup.ps1` file to the startup folder and choose `Create shortcuts here`
- Right click and edit the new shortcut, the target will look like `C:\dev\projects\pc-stats-nodejs\startup.ps1`, but you need to edit it to be `%SystemRoot%\system32\WindowsPowerShell\v1.0\powershell.exe -File "C:\dev\projects\iki-stats-nodejs\startup.ps1"` taking care to wrap the original file name in `"`

And that should be it... hopefully! You can try restarting the pc and seeing if it worked :D 

## Bonus

This app also has a little websockets webserver baked in that will respond to requests with a little subset of the last data recorded... I am using this for a mini oled arduino dashboard - i'll post that as a separate project.
