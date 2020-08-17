import {
  API,
  APIEvent,
  CharacteristicValue,
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
} from '@sunookitsune/node-ble';
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
  type: CommandType
};

type Lighthouse = {
  name: string,
  accessory: PlatformAccessory,
  device: Device,
  gatt?: GattServer,
  controlService?: GattService,
  powerCharacteristic?: GattCharacteristic,
  identifyCharacteristic?: GattCharacteristic,
  lastSuccess: Date,
  writeFails: number,
  readFails: number,
  readTimer?: NodeJS.Timeout
};

class LighthousePlatform implements DynamicPlatformPlugin {
  private readonly log: Logging;
  private readonly api: API;
  private readonly config: LighthousePlatformConfig;
  private readonly cachedAccessories: Array<PlatformAccessory> = [];
  private readonly lighthouses: Array<Lighthouse> = [];
  private readonly commandQueue: Array<Command> = [];
  private readonly scanTimeout: number;
  private readonly bleTimeout: number;
  private readonly updateFrequency: number;
  private queueRunning = false;

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log;
    this.config = config as unknown as LighthousePlatformConfig;
    this.api = api;

    this.scanTimeout = (this.config.scanTimeout || 10) * 1000;
    this.bleTimeout = (this.config.bleTimeout || 1.5) * 1000;
    this.updateFrequency = (this.config.updateFrequency || 30) * 1000;

    const {bluetooth, destroy} = createBluetooth();

    api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.scanBle(bluetooth);
    });
    api.on(APIEvent.SHUTDOWN, destroy);
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

  async scanBle(bluetooth: Bluetooth): Promise<void> {
    const adapter = await bluetooth.defaultAdapter();

    this.log('Scanning for Lighthouses...');
    if (!await adapter.isDiscovering()) {
      await adapter.startDiscovery();
    }

    setTimeout(async() => {
      adapter.stopDiscovery();
      this.log('Scanning complete');
      const devices = await adapter.devices();
      const uuids: Array<string> = [];
      devices.forEach(async(mac) => {
        const uuid = hap.uuid.generate(mac);
        uuids.push(uuid);
        try {
          const device = await adapter.getDevice(mac);
          const name = await device.getName();
          if (name.startsWith('LHB-')) {
            this.log('Found ' + name);
            await this.setupAccessory(device, uuid);
          }
        } catch {} // eslint-disable-line no-empty
      });

      const badAccessories = this.cachedAccessories.filter((curAcc) => {
        return !uuids.includes(curAcc.UUID);
      });
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, badAccessories);
    }, this.scanTimeout);
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.push(accessory);
  }

  async setupAccessory(device: Device, uuid: string): Promise<void> {
    const name = await device.getName();

    let accessory = this.cachedAccessories.find(cachedAccessory => {
      return cachedAccessory.displayName == name;
    });

    if (!accessory) {
      accessory = new Accessory(name, uuid);

      accessory.addService(hap.Service.Switch);

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    const lighthouse: Lighthouse = {
      name: name,
      accessory: accessory,
      device: device,
      lastSuccess: new Date(),
      writeFails: 0,
      readFails: 0
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

    const accInfo = accessory.getService(hap.Service.AccessoryInformation);
    if (accInfo) {
      accInfo
        .setCharacteristic(hap.Characteristic.Manufacturer, 'Valve Corporation')
        .setCharacteristic(hap.Characteristic.Model, 'Lighthouse 2.0')
        .setCharacteristic(hap.Characteristic.SerialNumber, name);
    }

    this.enqueueCommand(CommandType.GetUpdate, lighthouse);
  }

  getUpdate(lighthouse: Lighthouse): Promise<void> {
    if (lighthouse.readTimer) {
      clearTimeout(lighthouse.readTimer);
      lighthouse.readTimer = undefined;
    }
    return this.statusLighthouse(lighthouse)
      .then((isOn) => {
        lighthouse.lastSuccess = new Date();
        lighthouse.readFails = 0;
        lighthouse.accessory.getService(hap.Service.Switch)?.updateCharacteristic(hap.Characteristic.On, isOn);
      })
      .catch((error) => {
        lighthouse.readFails++;
        this.log.debug(lighthouse.name + ': ' + error + ' (' + lighthouse.readFails + ')');
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
        lighthouse.lastSuccess = new Date();
        lighthouse.writeFails = 0;
        lighthouse.accessory.getService(hap.Service.Switch)?.updateCharacteristic(hap.Characteristic.On, true);
      })
      .catch((error) => {
        this.log.error(lighthouse.name + ': ' + error);
      });
  }

  doPower(lighthouse: Lighthouse, state: boolean): Promise<void> {
    this.log('Turning ' + lighthouse.name + (state ? ' on...' : ' off...'));
    return this.powerLighthouse(lighthouse, state)
      .then(() => {
        lighthouse.lastSuccess = new Date();
        lighthouse.writeFails = 0;
      })
      .catch((error) => {
        lighthouse.writeFails++;
        this.log.error(lighthouse.name + ': ' + error + ' (' + lighthouse.writeFails + ')');
        lighthouse.accessory.getService(hap.Service.Switch)?.updateCharacteristic(hap.Characteristic.On, !state);
      });
  }

  enqueueCommand(commandType: CommandType, lighthouse: Lighthouse): void {
    this.commandQueue.push({
      lighthouse: lighthouse,
      type: commandType
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
        command = this.doPower(todoItem.lighthouse, true);
        break;
      case CommandType.PowerOff:
        command = this.doPower(todoItem.lighthouse, false);
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