import {
  API,
  APIEvent,
  CharacteristicValue,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  DynamicPlatformPlugin,
  HAP,
  Logging,
  PlatformAccessory,
  PlatformAccessoryEvent,
  PlatformConfig
} from 'homebridge';
import {
  createBluetooth,
  Bluetooth,
  Device,
  GattServer,
  GattService,
  GattCharacteristic
} from 'node-ble';
import fs from 'fs';
import pTimeout from 'p-timeout';
import { LighthousePlatformConfig } from './configTypes';

let hap: HAP;
let Accessory: typeof PlatformAccessory;

const PLUGIN_NAME = 'homebridge-lighthouse';
const PLATFORM_NAME = 'lighthouse';

const CONTROL_SERVICE = '00001523-1212-efde-1523-785feabcd124';
const POWER_CHARACTERISTIC = '00001525-1212-efde-1523-785feabcd124';
const IDENTIFY_CHARACTERISTIC = '00008421-1212-efde-1523-785feabcd124';
const OFF_VALUE = Buffer.from('00', 'hex');
const ON_VALUE = Buffer.from('01', 'hex');

enum CommandType {
  Identify,
  PowerOn,
  PowerOff,
  GetUpdate
}

type Command = {
  lighthouse: Lighthouse,
  type: CommandType,
  attempt: number
};

type Lighthouse = {
  name: string,
  accessory: PlatformAccessory,
  device: Device,
  gatt?: GattServer,
  controlService?: GattService,
  powerCharacteristic?: GattCharacteristic,
  identifyCharacteristic?: GattCharacteristic,
  readTimer?: NodeJS.Timeout
};

class LighthousePlatform implements DynamicPlatformPlugin {
  private readonly log: Logging;
  private readonly api: API;
  private readonly config: LighthousePlatformConfig;
  private readonly cachedAccessories: Array<PlatformAccessory> = [];
  private readonly lighthouses: Array<Lighthouse> = [];
  private readonly commandQueue: Array<Command> = [];
  private readonly retries: number;
  private readonly scanTimeout: number;
  private readonly bleTimeout: number;
  private readonly updateFrequency: number;
  private queueRunning = false;

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log;
    this.config = config as unknown as LighthousePlatformConfig;
    this.api = api;

    this.retries = this.config.retries || 3;
    this.scanTimeout = (this.config.scanTimeout || 10) * 1000;
    this.bleTimeout = (this.config.bleTimeout || 1.5) * 1000;
    this.updateFrequency = (this.config.updateFrequency || 30) * 1000;

    try {
      if (!fs.statSync('/var/run/dbus/system_bus_socket').isSocket()) {
        throw new Error('not a socket, /var/run/dbus/system_bus_socket');
      }

      const {bluetooth, destroy} = createBluetooth();
      api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
        this.scanBle(bluetooth);
      });
      api.on(APIEvent.SHUTDOWN, destroy);
    } catch (err) {
      this.log.error('Error setting up BLE connection: ' + err);
    }
  }

  powerLighthouse(lighthouse: Lighthouse, on: boolean): Promise<void> {
    const realPromise = lighthouse.device.connect()
      .then(async() => {
        if (!lighthouse.powerCharacteristic) {
          if (!lighthouse.controlService) {
            if (!lighthouse.gatt) {
              lighthouse.gatt = await lighthouse.device.gatt();
            }
            lighthouse.controlService = await lighthouse.gatt.getPrimaryService(CONTROL_SERVICE);
          }
          lighthouse.powerCharacteristic = await lighthouse.controlService.getCharacteristic(POWER_CHARACTERISTIC);
        }
        return lighthouse.powerCharacteristic;
      })
      .then((characteristic) => {
        return characteristic.writeValue(on ? ON_VALUE : OFF_VALUE);
      });
    return pTimeout(realPromise, this.bleTimeout, 'Write attempt timed out.')
      .finally(() => {
        lighthouse.device.disconnect();
      });
  }

  statusLighthouse(lighthouse: Lighthouse): Promise<boolean> {
    const realPromise = lighthouse.device.connect()
      .then(async() => {
        if (!lighthouse.powerCharacteristic) {
          if (!lighthouse.controlService) {
            if (!lighthouse.gatt) {
              lighthouse.gatt = await lighthouse.device.gatt();
            }
            lighthouse.controlService = await lighthouse.gatt.getPrimaryService(CONTROL_SERVICE);
          }
          lighthouse.powerCharacteristic = await lighthouse.controlService.getCharacteristic(POWER_CHARACTERISTIC);
        }
        return lighthouse.powerCharacteristic;
      })
      .then(async(characteristic) => {
        const power = await characteristic.readValue();
        return !power.equals(OFF_VALUE);
      });
    return pTimeout(realPromise, this.bleTimeout, 'Read attempt timed out.')
      .finally(() => {
        lighthouse.device.disconnect();
      });
  }

  identifyLighthouse(lighthouse: Lighthouse): Promise<void> {
    const realPromise = lighthouse.device.connect()
      .then(async() => {
        if (!lighthouse.identifyCharacteristic) {
          if (!lighthouse.controlService) {
            if (!lighthouse.gatt) {
              lighthouse.gatt = await lighthouse.device.gatt();
            }
            lighthouse.controlService = await lighthouse.gatt.getPrimaryService(CONTROL_SERVICE);
          }
          lighthouse.identifyCharacteristic = await lighthouse.controlService.getCharacteristic(IDENTIFY_CHARACTERISTIC);
        }
        return lighthouse.identifyCharacteristic;
      })
      .then((characteristic) => {
        return characteristic.writeValue(ON_VALUE);
      });
    return pTimeout(realPromise, this.bleTimeout, 'Identify attempt timed out.')
      .finally(() => {
        lighthouse.device.disconnect();
      });
  }

  finishScan(found: Array<string>): void {
    if (this.config.lighthouses?.length > 0) {
      this.config.lighthouses.forEach((lhId) => {
        const lh = this.lighthouses.find((curLh) => {
          return curLh.name == lhId;
        });
        if (!lh) {
          this.log('Not Found: ' + lhId);
          this.setupAccessory(lhId);
        }
      });

      this.cachedAccessories.forEach((curAcc) => {
        if (!this.config.lighthouses.includes(curAcc.displayName)) {
          this.log('Removing cached accessory: ' + curAcc.displayName);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [curAcc]);
        }
      });
    } else {
      this.cachedAccessories.forEach((curAcc) => {
        if (!found.includes(curAcc.displayName)) {
          this.log('Removing cached accessory: ' + curAcc.displayName);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [curAcc]);
        }
      });
    }
  }

  async scanBle(bluetooth: Bluetooth): Promise<void> {
    try {
      const adapter = await bluetooth.defaultAdapter();

      this.log('Scanning for Lighthouses...');
      if (!await adapter.isDiscovering()) {
        await adapter.startDiscovery();
      }

      setTimeout(async() => {
        adapter.stopDiscovery();
        this.log('Scanning complete');
        const devices = await adapter.devices();
        const found: Array<string> = [];
        for (const mac of devices) {
          try {
            const device = await adapter.getDevice(mac);
            const name = await device.getName();
            if (this.config.lighthouses?.length > 0) {
              if (this.config.lighthouses.includes(name)) {
                this.log('Found: ' + name);
                await this.setupAccessory(name, device);
              } else if (name.startsWith('LHB-')) {
                this.log('Found: ' + name + ' (skipped)');
              }
            } else if (name.startsWith('LHB-')) {
              this.log('Found: ' + name);
              await this.setupAccessory(name, device);
              found.push(name);
            }
          } catch {
            // Swallow error
          }
        }
        this.finishScan(found);
      }, this.scanTimeout);
    } catch (err) {
      this.log.error('Error scanning for Lighthouses: ' + err);
      this.finishScan([]);
    }
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.push(accessory);
  }

  async setupAccessory(name: string, device?: Device): Promise<void> {
    let accessory = this.cachedAccessories.find(cachedAccessory => {
      return cachedAccessory.displayName == name;
    });

    if (!accessory) {
      const uuid = hap.uuid.generate(name);
      accessory = new Accessory(name, uuid);

      accessory.addService(hap.Service.Switch);

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    const accInfo = accessory.getService(hap.Service.AccessoryInformation);
    if (accInfo) {
      accInfo
        .setCharacteristic(hap.Characteristic.Manufacturer, 'Valve Corporation')
        .setCharacteristic(hap.Characteristic.Model, 'Lighthouse 2.0')
        .setCharacteristic(hap.Characteristic.SerialNumber, name);
    }

    if (device) {
      const lighthouse: Lighthouse = {
        name: name,
        accessory: accessory,
        device: device
      };
      this.lighthouses.push(lighthouse);

      accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
        this.enqueueCommand(CommandType.Identify, lighthouse);
      });

      accessory.getService(hap.Service.Switch)?.getCharacteristic(hap.Characteristic.On)
        .on('set', (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
          this.enqueueCommand(state ? CommandType.PowerOn : CommandType.PowerOff, lighthouse);
          callback();
        });

      this.enqueueCommand(CommandType.GetUpdate, lighthouse);
    } else {
      accessory.getService(hap.Service.Switch)?.getCharacteristic(hap.Characteristic.On)
        .on('set', (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
          callback(new Error());
        })
        .on('get', (callback: CharacteristicGetCallback) => {
          callback(new Error());
        });
    }
  }

  getUpdate(lighthouse: Lighthouse): Promise<void> {
    if (lighthouse.readTimer) {
      clearTimeout(lighthouse.readTimer);
      lighthouse.readTimer = undefined;
    }
    return this.statusLighthouse(lighthouse)
      .then((isOn) => {
        lighthouse.accessory.getService(hap.Service.Switch)?.updateCharacteristic(hap.Characteristic.On, isOn);
      })
      .catch((error) => {
        this.log.debug(lighthouse.name + ': Error getting update: ' + error );
      })
      .finally(() => {
        lighthouse.readTimer = setTimeout(() => {
          this.enqueueCommand(CommandType.GetUpdate, lighthouse);
        }, this.updateFrequency);
      });
  }

  doIdentify(lighthouse: Lighthouse): Promise<void> {
    this.log('Identifying ' + lighthouse.name + '...');
    return this.identifyLighthouse(lighthouse)
      .then(() => {
        lighthouse.accessory.getService(hap.Service.Switch)?.updateCharacteristic(hap.Characteristic.On, true);
      })
      .catch((error) => {
        this.log.error(lighthouse.name + ': Error identifying: ' + error);
      });
  }

  doPower(lighthouse: Lighthouse, state: boolean, attempt: number): Promise<void> {
    this.log('Turning ' + lighthouse.name + (state ? ' on...' : ' off...') +
      (attempt > 1 ? ' (Attempt ' + attempt + ')' : ''));
    return this.powerLighthouse(lighthouse, state)
      .catch((error) => {
        if (attempt < this.retries) {
          this.log.debug(lighthouse.name + ': Error setting power, retrying: ' + error);
          this.enqueueCommand(state ? CommandType.PowerOn : CommandType.PowerOff, lighthouse, attempt + 1);
        } else {
          this.log.error(lighthouse.name + ': Error setting power: ' + error);
          lighthouse.accessory.getService(hap.Service.Switch)?.updateCharacteristic(hap.Characteristic.On, !state);
        }
      });
  }

  enqueueCommand(commandType: CommandType, lighthouse: Lighthouse, attempt = 1): void {
    this.commandQueue.push({
      lighthouse: lighthouse,
      type: commandType,
      attempt: attempt
    });
    if (!this.queueRunning) {
      this.queueRunning = true;
      this.nextCommand();
    }
  }

  nextCommand(): void {
    const todoItem = this.commandQueue.shift();
    if (!todoItem) {
      return;
    }

    let command;
    switch (todoItem.type) {
      case CommandType.Identify:
        command = this.doIdentify(todoItem.lighthouse);
        break;
      case CommandType.PowerOn:
        command = this.doPower(todoItem.lighthouse, true, todoItem.attempt);
        break;
      case CommandType.PowerOff:
        command = this.doPower(todoItem.lighthouse, false, todoItem.attempt);
        break;
      case CommandType.GetUpdate:
        command = this.getUpdate(todoItem.lighthouse);
        break;
    }

    command.then(() => {
      if (this.commandQueue.length > 0) {
        this.nextCommand();
      } else {
        this.queueRunning = false;
      }
    });
  }
}

export = (api: API): void => {
  hap = api.hap;
  Accessory = api.platformAccessory;

  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, LighthousePlatform);
};