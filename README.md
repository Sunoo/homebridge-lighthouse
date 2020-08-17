# homebridge-lighthouse

[![npm](https://img.shields.io/npm/v/homebridge-lighthouse) ![npm](https://img.shields.io/npm/dt/homebridge-lighthouse)](https://www.npmjs.com/package/homebridge-lighthouse)

[Valve Lighthouse 2.0](https://www.valvesoftware.com/en/index/base-stations) plugin for [Homebridge](https://homebridge.io)

## Installation

1. Install Homebridge using the [official instructions](https://github.com/homebridge/homebridge/wiki).
2. Create the D-Bus configuration file. See below.
3. Install this plugin using: `sudo npm install -g homebridge-lighthouse --unsafe-perm`.
4. Update your configuration file. See sample config.json snippet below.

### D-Bus Configuration

Create the file `/etc/dbus-1/system.d/homebridge-lighthouse.conf` with the following contents:

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

### Homebridge Configuration

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
