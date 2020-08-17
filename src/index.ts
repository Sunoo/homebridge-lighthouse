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
import noble from '@abandonware/noble';
import { LighthousePlatformConfig } from './configTypes';

let hap: HAP;
let Accessory: typeof PlatformAccessory;

const PLUGIN_NAME = 'homebridge-lighthouse';
const PLATFORM_NAME = 'lighthouse';

const CONTROL_SVC = '000015231212efde1523785feabcd124';
const POWER_CHAR = '000015251212efde1523785feabcd124';
const IDENTIFY_CHAR = '000084211212efde1523785feabcd124';
const OFF_VAL = Buffer.from('00', 'hex');
const ON_VAL = Buffer.from('01', 'hex');

enum CommandType {
  Identify,
  PowerOn,
  PowerOff,
  GetUpdate
}

type Command = {
  accessory: PlatformAccessory,
  peripheral: noble.Peripheral,
  type: CommandType
};

class LighthousePlatform implements DynamicPlatformPlugin {
  private readonly log: Logging;
  private readonly api: API;
  private readonly config: LighthousePlatformConfig;
  private readonly peripherals: Array<noble.Peripheral> = [];
  private readonly cachedAccessories: Array<PlatformAccessory> = [];
  private readonly accessories: Array<PlatformAccessory> = [];
  private readonly commandQueue: Array<Command> = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
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

    api.on(APIEvent.DID_FINISH_LAUNCHING, this.didFinishLaunching.bind(this));
  }

  powerLighthouse(peripheral: noble.Peripheral, on: boolean): Promise<void> {
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject('Write attempt timed out.');
      }, this.bleTimeout);
    });
    const realPromise = peripheral.connectAsync()
      .then(() => {
        return peripheral.discoverSomeServicesAndCharacteristicsAsync([CONTROL_SVC], [POWER_CHAR]);
      })
      .then(({characteristics}) => {
        return characteristics[0].writeAsync(on ? ON_VAL : OFF_VAL, false);
      });
    return Promise.race([timeoutPromise, realPromise])
      .finally(() => {
        peripheral.disconnectAsync();
      });
  }

  statusLighthouse(peripheral: noble.Peripheral): Promise<boolean> {
    const timeoutPromise = new Promise<boolean>((_, reject) => {
      setTimeout(() => {
        reject('Read attempt timed out.');
      }, this.bleTimeout);
    });
    const realPromise = peripheral.connectAsync()
      .then(() => {
        return peripheral.discoverSomeServicesAndCharacteristicsAsync([CONTROL_SVC], [POWER_CHAR]);
      })
      .then(({characteristics}) => {
        return characteristics[0].readAsync();
      })
      .then((power) => {
        return !power.equals(OFF_VAL);
      });
    return Promise.race([timeoutPromise, realPromise])
      .finally(() => {
        peripheral.disconnectAsync();
      });
  }

  identifyLighthouse(peripheral: noble.Peripheral): Promise<void> {
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject('Identify attempt timed out.');
      }, this.bleTimeout);
    });
    const realPromise = peripheral.connectAsync()
      .then(() => {
        return peripheral.discoverSomeServicesAndCharacteristicsAsync([CONTROL_SVC], [IDENTIFY_CHAR]);
      })
      .then(({characteristics}) => {
        return characteristics[0].writeAsync(ON_VAL, false);
      });
    return Promise.race([timeoutPromise, realPromise])
      .finally(() => {
        peripheral.disconnectAsync();
      });
  }

  didFinishLaunching(): void {
    noble.on('warning', (message: string) => this.log.warn(message));
    noble.on('scanStart', () => this.log('Scanning for Lighthouses...'));
    noble.on('scanStop',  () => this.log('Scanning complete'));

    noble.startScanning();

    setTimeout(() => {
      noble.stopScanning();

      this.peripherals.forEach(async(curPer) => {
        this.enqueueCommand(CommandType.GetUpdate, curPer);
      });

      const badAccessories = this.cachedAccessories.filter((curAcc) => {
        return !this.peripherals.find((curPer) => {
          return curPer.advertisement.localName == curAcc.displayName;
        });
      });
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, badAccessories);
    }, this.scanTimeout);

    noble.on('discover', async(peripheral) => {
      if (peripheral.advertisement.localName?.startsWith('LHB-')) {
        this.log('Found ' + peripheral.advertisement.localName);
        this.peripherals.push(peripheral);
        this.setupAccessory(peripheral);
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.push(accessory);
  }

  setupAccessory(peripheral: noble.Peripheral): void {
    let accessory = this.cachedAccessories.find(cachedAccessory => {
      return cachedAccessory.displayName == peripheral.advertisement.localName;
    });

    if (!accessory) {
      const uuid = hap.uuid.generate(peripheral.advertisement.localName);
      accessory = new Accessory(peripheral.advertisement.localName, uuid);

      accessory.addService(hap.Service.Switch);

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    this.accessories.push(accessory);

    accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      if (peripheral && accessory) {
        this.enqueueCommand(CommandType.Identify, peripheral, accessory);
      }
    });

    accessory.getService(hap.Service.Switch)?.getCharacteristic(hap.Characteristic.On)
      .on('set', (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
        this.enqueueCommand(state ? CommandType.PowerOn : CommandType.PowerOff, peripheral, accessory);
        callback();
      });

    const accInfo = accessory.getService(hap.Service.AccessoryInformation);
    if (accInfo) {
      accInfo
        .setCharacteristic(hap.Characteristic.Manufacturer, 'Valve Corporation')
        .setCharacteristic(hap.Characteristic.Model, 'Lighthouse 2.0')
        .setCharacteristic(hap.Characteristic.SerialNumber, peripheral.advertisement.localName);
    }
  }

  getUpdate(accessory: PlatformAccessory, peripheral: noble.Peripheral): Promise<void> {
    const timer = this.timers.get(peripheral.advertisement.localName);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(peripheral.advertisement.localName);
    }
    return this.statusLighthouse(peripheral)
      .then((isOn) => {
        accessory.getService(hap.Service.Switch)?.updateCharacteristic(hap.Characteristic.On, isOn);
      })
      .catch((error) => {
        this.log.debug(peripheral.advertisement.localName + ': ' + error);
      })
      .finally(() => {
        const timer = setTimeout(() => {
          this.enqueueCommand(CommandType.GetUpdate, peripheral, accessory);
        }, this.updateFrequency);
        this.timers.set(peripheral.advertisement.localName, timer);
      });
  }

  doIdentify(accessory: PlatformAccessory, peripheral: noble.Peripheral): Promise<void> {
    this.log('Identifying ' + accessory.displayName + '...');
    return this.identifyLighthouse(peripheral)
      .then(() => {
        accessory.getService(hap.Service.Switch)?.updateCharacteristic(hap.Characteristic.On, true);
      })
      .catch((error) => {
        this.log.error(peripheral.advertisement.localName + ': ' + error);
      });
  }

  doPower(accessory: PlatformAccessory, peripheral: noble.Peripheral, state: boolean): Promise<void> {
    this.log('Turning ' + peripheral.advertisement.localName + (state ? ' on...' : ' off...'));
    return this.powerLighthouse(peripheral, state)
      .catch((error) => {
        accessory.getService(hap.Service.Switch)?.updateCharacteristic(hap.Characteristic.On, !state);
        this.log.error(peripheral.advertisement.localName + ': ' + error);
      });
  }

  enqueueCommand(commandType: CommandType, peripheral: noble.Peripheral, accessory?: PlatformAccessory): void {
    if (!accessory) {
      accessory = this.accessories.find((curAcc) => {
        return curAcc.displayName == peripheral.advertisement.localName;
      });
    }
    if (accessory) {
      this.commandQueue.push({
        'accessory': accessory,
        'peripheral': peripheral,
        'type': commandType
      });
      if (!this.queueRunning) {
        this.queueRunning = true;
        this.nextCommand();
      }
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
        command = this.doIdentify(todoItem.accessory, todoItem.peripheral);
        break;
      case CommandType.PowerOn:
        command = this.doPower(todoItem.accessory, todoItem.peripheral, true);
        break;
      case CommandType.PowerOff:
        command = this.doPower(todoItem.accessory, todoItem.peripheral, false);
        break;
      case CommandType.GetUpdate:
        command = this.getUpdate(todoItem.accessory, todoItem.peripheral);
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