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
  lighthouse: Lighthouse,
  type: CommandType
};

type Lighthouse = {
  name: string,
  accessory: PlatformAccessory,
  peripheral: noble.Peripheral,
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

      this.lighthouses.forEach(async(curLH) => {
        this.enqueueCommand(CommandType.GetUpdate, curLH);
      });

      const badAccessories = this.cachedAccessories.filter((curAcc) => {
        return !this.lighthouses.find((curLH) => {
          return curLH.name == curAcc.displayName;
        });
      });
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, badAccessories);
    }, this.scanTimeout);

    noble.on('discover', async(peripheral) => {
      if (peripheral.advertisement.localName?.startsWith('LHB-')) {
        this.log('Found ' + peripheral.advertisement.localName);
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

    const lighthouse: Lighthouse = {
      name: peripheral.advertisement.localName,
      accessory: accessory,
      peripheral: peripheral,
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
        .setCharacteristic(hap.Characteristic.SerialNumber, peripheral.advertisement.localName);
    }
  }

  getUpdate(lighthouse: Lighthouse): Promise<void> {
    if (lighthouse.readTimer) {
      clearTimeout(lighthouse.readTimer);
      lighthouse.readTimer = undefined;
    }
    return this.statusLighthouse(lighthouse.peripheral)
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
    return this.identifyLighthouse(lighthouse.peripheral)
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
    return this.powerLighthouse(lighthouse.peripheral, state)
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