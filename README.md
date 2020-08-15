# homebridge-lighthouse

[![npm](https://img.shields.io/npm/v/homebridge-lighthouse) ![npm](https://img.shields.io/npm/dt/homebridge-lighthouse)](https://www.npmjs.com/package/homebridge-lighthouse)

[Valve Lighthouse 2.0](https://www.valvesoftware.com/en/index/base-stations) plugin for [Homebridge](https://homebridge.io)

## Installation

1. Install Homebridge using the [official instructions](https://github.com/homebridge/homebridge/wiki).
2. Follow the [prerequisites for Noble](https://github.com/abandonware/noble#prerequisites).
3. Install this plugin using: `sudo npm install -g homebridge-lighthouse --unsafe-perm`.
4. Update your configuration file. See sample config.json snippet below.

### Configuration

Configuration sample:

```json
"platforms": [
    {
        "platform": "lighthouse",
        "scanTimeout": 10,
        "bleTimeout": 1,
        "updateFrequency": 60,
    }
]
```

#### Fields

* "platform": Must always be "lighthouse". (required)
* "scanTimeout": Number of seconds to search for Lighthouses at startup.
* "bleTimeout": Number of seconds to allow for BLE commands.
* "updateFrequency": Number of seconds between attempts to check status of the Lighthouses.
