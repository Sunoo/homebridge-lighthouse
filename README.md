# homebridge-lighthouse

[![npm](https://img.shields.io/npm/v/homebridge-lighthouse) ![npm](https://img.shields.io/npm/dt/homebridge-lighthouse)](https://www.npmjs.com/package/homebridge-lighthouse) [![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

[Valve Lighthouse 2.0](https://www.valvesoftware.com/en/index/base-stations) plugin for [Homebridge](https://homebridge.io)

## Installation

1. Install Homebridge using the [official instructions](https://github.com/homebridge/homebridge/wiki).
2. Install this plugin using: `sudo npm install -g homebridge-lighthouse --unsafe-perm`.
3. Update your configuration file. See sample config.json snippet below.

### Homebridge Configuration

Configuration sample:

```json
"platforms": [
    {
        "platform": "lighthouse",
        "lighthouses": [
          "LHB-ADD18BFB",
          "LHB-02BF1E38"
        ],
        "scanTimeout": 10,
        "bleTimeout": 1,
        "updateFrequency": 60,
    }
]
```

#### Fields

- "platform": Must always be "lighthouse". (required)
- "lighthouses": An array of Lighthouses to connect to. If not set, all detected lighthouses will be added to HomeKit.
- "scanTimeout": Number of seconds to search for Lighthouses at startup. (Default: `10`)
- "bleTimeout": Number of seconds to allow for BLE commands. (Defualt: `1.5`)
- "updateFrequency": Number of seconds between attempts to check status of the Lighthouses. (Default: `30`)

### D-Bus Configuration

If you are getting permission errors, you may need to create the file `/etc/dbus-1/system.d/homebridge-lighthouse.conf` with the following contents:

```xml
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
  "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="homebridge">
   <allow own="org.bluez"/>
    <allow send_destination="org.bluez"/>
    <allow send_interface="org.bluez.GattCharacteristic1"/>
    <allow send_interface="org.bluez.GattDescriptor1"/>
    <allow send_interface="org.freedesktop.DBus.ObjectManager"/>
    <allow send_interface="org.freedesktop.DBus.Properties"/>
  </policy>
</busconfig>
```

If you are running Homebridge under an ID other than `homebridge`, change the `policy user` line above.
