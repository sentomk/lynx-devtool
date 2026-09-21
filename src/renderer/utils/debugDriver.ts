// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import {
  EDebugDriverEventNames,
  ICustomMessage,
  IDebugDriver,
  IDebugDriverEvent2Payload,
  IDevice,
  IDeviceInfo
} from '@lynx-js/devtool-plugin-core/renderer';
import {
  ECustomDataType,
  ERemoteDebugDriverEventNames,
  ERemoteDebugDriverExternalEvent,
  ERemoteDebugDriverInternalEvent,
  ICustomDataWrapper,
  IRemoteDebugServer4Driver,
  ISocketMessage,
  SocketEvents,
  createRemoteDebugDriver
} from '@lynx-js/remote-debug-driver';
import useConnection from '../hooks/connection';
import LDT_CONST from './const';
import { getStore } from './flooks';
import { getCurrentIntranetIp } from './ldtApi';

class DebugDriver implements IDebugDriver {
  debugDriverInstance: IRemoteDebugServer4Driver | null = null;
  debugDriverInitPromise: Promise<IRemoteDebugServer4Driver> | null = null;

  private cancelId = 0;
  private _messageIndex = 1;
  private _listenerMap = new Map<EDebugDriverEventNames, ((payload: any) => void)[]>();

  async connect(url: string, roomId: string): Promise<IRemoteDebugServer4Driver> {
    const driver = await this._bootstrapRemoteDriver(url, roomId);
    // after reconnecting of driver, need to re-register the listener
    this._listenerMap.forEach((value, key) => {
      value.forEach((listener) => {
        if (this._isRemoteEvent(key)) {
          driver.off(key as ERemoteDebugDriverEventNames, listener);
          driver.on(key as ERemoteDebugDriverEventNames, listener);
        }
      });
    });
    return driver;
  }

  async getRemoteSchema(prefix?: string) {
    const driver = await this.getRemoteDebugDriver();
    let url = driver.getRemoteDebugAppSchema(prefix, false);
    if (url.includes('127.0.0.1')) {
      const useVpn = localStorage.getItem(LDT_CONST.KEY_USE_VPN_IP) === 'true';
      const innerIp = await getCurrentIntranetIp(!useVpn);
      url = url.replace('127.0.0.1', innerIp);
    }
    return url;
  }

  async sendCustomMessage(data: ICustomMessage) {
    if (!data.clientId) {
      data.clientId = this.getSelectClientId();
    }
    const customData: ICustomDataWrapper<any> = {
      type: data.type ?? 'CDP',
      data: {
        client_id: data.clientId,
        session_id: data.sessionId ?? -1
      }
    };
    if (data.useParamsAsData) {
      Object.assign(customData.data, data.params);
      // support sending App type messages
      if (data.params?.id && customData.data.message) {
        customData.data.message.id = data.params.id;
      }
    } else {
      customData.data.message = typeof data.params === 'string' ? data.params : JSON.stringify(data.params);
    }
    const driver = await this.getRemoteDebugDriver();
    driver.sendCustomMessage(customData);
  }

  getSelectClientId(): number | undefined {
    const { selectedDevice } = getStore(useConnection);
    return selectedDevice?.clientId;
  }

  setSelectClientId(clientId?: number) {
    const { deviceList, setSelectedDevice } = getStore(useConnection);
    if (clientId) {
      const device = deviceList.find((item) => item.clientId === clientId);
      if (device) {
        setSelectedDevice({ ...device });
      }
    }
  }

  getSelectSessionId(): number | undefined {
    const { selectedDevice, deviceInfoMap } = getStore(useConnection);
    return deviceInfoMap[selectedDevice?.clientId || '']?.selectedSession?.session_id;
  }
  setSelectSessionId(sessionId?: number) {
    const { setSelectedSession } = getStore(useConnection);
    if (sessionId) {
      setSelectedSession(sessionId);
    }
  }

  getClientInfo(clientId: number): IDeviceInfo | undefined {
    const { deviceInfoMap } = getStore(useConnection);
    return deviceInfoMap[clientId];
  }

  getDeviceInfo(clientId: number): IDevice | undefined {
    const { deviceList } = getStore(useConnection);
    return deviceList.find((item) => item.clientId === clientId);
  }

  sendMessageToApp(method: string, params: any) {
    return this.sendCustomMessageAsync({
      type: 'App',
      params: {
        message: {
          method,
          params
        }
      },
      useParamsAsData: true
    });
  }

  sendCustomMessageAsync(data: ICustomMessage, timeout = 30000): Promise<any> {
    const { params, type, sessionId } = data;
    const clientId = data.clientId && data.clientId !== -1 ? data.clientId : this.getSelectClientId();
    params.id = this._messageIndex++;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const listener = (event: ISocketMessage<any>) => {
        if (
          event.event === SocketEvents.Customized &&
          (event.data?.type === (type ?? 'CDP') ||
            (event.data?.type === ECustomDataType.R2DStopAtEntry && type === ECustomDataType.D2RStopAtEntry) ||
            (event.data?.type === ECustomDataType.R2DStopLepusAtEntry &&
              type === ECustomDataType.D2RStopLepusAtEntry) ||
            (event.data?.type === LDT_CONST.MSG_ScreenshotCaptured && type === LDT_CONST.MSG_GetScreenshot) ||
            (event.data?.type === 'get_props_resp' && type === 'xdb_globalprops')) &&
          (event.data?.data?.client_id === clientId || event.data?.sender === clientId)
        ) {
          let message = event.data?.data?.message;
          if (message === undefined) {
            message = event.data?.data;
          } else if (typeof message === 'string') {
            message = JSON.parse(message);
          }
          let isCallback = false;
          if (
            type === LDT_CONST.MSG_GetGlobalSwitch ||
            type === LDT_CONST.MSG_SetGlobalSwitch ||
            type === ECustomDataType.D2RStopLepusAtEntry ||
            type === ECustomDataType.D2RStopAtEntry
          ) {
            isCallback = true;
          } else if (type === 'xdb_jsb' && message?.type === 'invoke_resp') {
            isCallback = true;
          } else if (type === 'xdb_globalprops' && message?.type === 'get_props_resp') {
            isCallback = true;
          } else if (
            params?.method === LDT_CONST.MSG_GetScreenshot &&
            message?.method === LDT_CONST.MSG_ScreenshotCaptured &&
            event.data?.data?.session_id &&
            event.data?.data?.session_id === sessionId
          ) {
            isCallback = true;
          } else if (params?.method !== LDT_CONST.MSG_GetScreenshot) {
            // screenshot cdp message does not meet the standard, needs special handling
            isCallback = message?.id === params?.id;
          }

          if (isCallback) {
            this.off(ERemoteDebugDriverExternalEvent.All, listener);
            timer && clearTimeout(timer);
            if (type === 'App') {
              const result = JSON.parse(message.result || '{}');
              if (result.code < 0) {
                reject(new Error(`${message.method} ${result.message}`));
              } else {
                resolve(result);
              }
            } else {
              resolve(message);
            }
          }
        }
      };
      timer = setTimeout(() => {
        this.off(ERemoteDebugDriverExternalEvent.All, listener);
        if (type === 'CDP') {
          reject(new Error(`send ${type} message timeout, method: ${params.method}`));
        } else {
          reject(new Error(`send ${type} message timeout`));
        }
      }, timeout);
      this.on(ERemoteDebugDriverExternalEvent.All, listener);
      this.sendCustomMessage(data);
    });
  }

  emit(name: EDebugDriverEventNames, payload: any) {
    this._listenerMap.get(name)?.forEach((listener) => {
      listener(payload);
    });
  }

  async on<T extends EDebugDriverEventNames>(name: T, callback: (payload: IDebugDriverEvent2Payload[T]) => void) {
    const listeners = this._listenerMap.get(name);
    if (listeners) {
      if (!listeners.includes(callback)) {
        listeners.push(callback);
      }
    } else {
      this._listenerMap.set(name, [callback]);
    }

    try {
      if (this._isRemoteEvent(name)) {
        const driver = await this.getRemoteDebugDriver();
        driver.on(name as ERemoteDebugDriverEventNames, callback as any);
      }
    } catch {}
  }

  off<T extends EDebugDriverEventNames>(name: T, callback: (payload: IDebugDriverEvent2Payload[T]) => void) {
    if (this._isRemoteEvent(name)) {
      this.getRemoteDebugDriver()
        .then((driver) => driver.off(name as ERemoteDebugDriverEventNames, callback as any))
        .catch(() => {
          //
        });
    }
    const listeners = this._listenerMap.get(name);
    const index = listeners?.indexOf(callback) ?? -1;
    if (index >= 0) {
      listeners?.splice(index, 1);
    }
  }

  getRemoteDebugDriver(): Promise<IRemoteDebugServer4Driver> {
    if (this.debugDriverInstance) {
      return Promise.resolve(this.debugDriverInstance);
    } else if (this.debugDriverInitPromise) {
      return this.debugDriverInitPromise;
    } else {
      return Promise.reject(new Error('devtool not connected'));
    }
  }

  listSessions(clientId: number) {
    return this.sendCustomMessage({
      type: 'ListSession',
      params: {
        client_id: clientId
      },
      useParamsAsData: true
    });
  }

  isMainProcess(device: IDevice) {
    return device.info?.AppProcessName?.includes(':') !== true;
  }

  getAppProcess = (device: IDevice) => {
    const { info } = device;
    if (info?.AppProcessName) {
      const arr = info.AppProcessName.split(':');
      if (arr.length === 2) {
        return `:${arr[1]}`;
      }
    }
    return null;
  };

  private _bootstrapRemoteDriver(url?: string, room?: string): Promise<IRemoteDebugServer4Driver> {
    console.log(`[Debug Driver] Starting bootstrap with URL: ${url}, room: ${room}`);

    if (this.debugDriverInstance) {
      console.log('[Debug Driver] Stopping existing driver instance');
      this.debugDriverInstance.stop();
      this.debugDriverInstance = null;
    }

    this.cancelId++;
    const id = this.cancelId;
    console.log(`[Debug Driver] Assigned connection ID: ${id}`);

    // try to create a debug server connection Promise
    let wsUrl = url;

    let timer: any = null;
    const createDriver = new Promise<IRemoteDebugServer4Driver>(async (resolve, reject) => {
      try {
        console.log('[Debug Driver] Getting current intranet IP...');
        const ip = await getCurrentIntranetIp();
        console.log(`[Debug Driver] Current intranet IP: ${ip}`);

        // Check if we should convert URL to localhost
        let shouldConvertToLocalhost = false;

        if (ip && wsUrl?.includes(ip)) {
          console.log(`[Debug Driver] URL contains detected intranet IP (${ip}), converting to localhost...`);
          shouldConvertToLocalhost = true;
        } else if (!ip && wsUrl?.match(/ws:\/\/10\.\d+\.\d+\.\d+:/)) {
          console.log('[Debug Driver] IP detection failed but URL looks like local network, converting to localhost...');
          shouldConvertToLocalhost = true;
        } else if (!ip && wsUrl?.match(/ws:\/\/192\.168\.\d+\.\d+:/)) {
          console.log('[Debug Driver] IP detection failed but URL looks like local network, converting to localhost...');
          shouldConvertToLocalhost = true;
        }

        if (shouldConvertToLocalhost && wsUrl) {
          const arr = wsUrl.substring(5, wsUrl.indexOf('/mdevices/page/android')).split(':');
          if (arr.length === 2) {
            const newUrl = `ws://127.0.0.1:${arr[1]}/mdevices/page/android`;
            console.log(`[Debug Driver] Converted URL: ${wsUrl} -> ${newUrl}`);
            wsUrl = newUrl;
          }
        } else {
          console.log('[Debug Driver] No URL conversion needed, using original URL');
        }

        if (!wsUrl) {
          console.error('[Debug Driver] No WebSocket URL provided');
          throw new Error('Cannot create remote debug driver without wsUrl');
        }

        console.log(`[Debug Driver] Creating remote debug driver with URL: ${wsUrl}, room: ${room}`);

        createRemoteDebugDriver(wsUrl, room).then((debugDriver) => {
          console.log('[Debug Driver] Remote debug driver created successfully');
          if (timer) {
            console.log('[Debug Driver] Clearing connection timeout');
            clearTimeout(timer);
          }
          if (id === this.cancelId) {
            console.log(`[Debug Driver] Connection ID ${id} matches current ID, resolving`);
            this.debugDriverInstance = debugDriver;
            resolve(debugDriver);
          } else {
            console.log(`[Debug Driver] Connection ID ${id} doesn't match current ID ${this.cancelId}, stopping driver`);
            debugDriver.stop();
            reject(new Error('connection closed because a new connection is initialized.'));
          }
        }).catch((error) => {
          console.error('[Debug Driver] Failed to create remote debug driver:', error);
          reject(error);
        });
      } catch (error) {
        console.error('[Debug Driver] Error in createDriver Promise:', error);
        reject(error);
      }
    });

    // timeout Promise
    const timeout = new Promise<IRemoteDebugServer4Driver>((_, reject) => {
      timer = setTimeout(() => {
        console.error(`[Debug Driver] Connection timeout after 10 seconds. URL: ${wsUrl}${room ? `&room=${room}` : ''}`);
        console.error('[Debug Driver] Please check:');
        console.error('  1. Is the debug router service running?');
        console.error('  2. Is the WebSocket URL accessible?');
        console.error('  3. Are there any firewall issues?');
        reject(new Error('connection timeout (10 seconds).'));
      }, 10000);
    });

    // create successfully or timeout will end async call
    console.log('[Debug Driver] Starting connection race between create and timeout');
    this.debugDriverInitPromise = Promise.race([createDriver, timeout]);
    return this.debugDriverInitPromise;
  }

  private _isRemoteEvent(event: EDebugDriverEventNames) {
    return ERemoteDebugDriverExternalEvent[event] !== undefined || ERemoteDebugDriverInternalEvent[event] !== undefined;
  }
}

const debugDriver = new DebugDriver();
export default debugDriver;
