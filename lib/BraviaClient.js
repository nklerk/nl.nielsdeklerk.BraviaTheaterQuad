'use strict';

const net = require('net');
const EventEmitter = require('events');

// Features
const FEATURE_POWER = 'main.power';
const FEATURE_VOLUME = 'main.volumestep';
const FEATURE_INPUT = 'main.input';
const FEATURE_REAR_LEVEL = 'main.rearvolumestep';
const FEATURE_BASS_LEVEL = 'main.bassstep';
const FEATURE_VOICE_ENHANCER = 'audio.voiceenhancer';
const FEATURE_SOUND_FIELD = 'audio.soundfield';
const FEATURE_NIGHT_MODE = 'audio.nightmode';
const FEATURE_HDMI_CEC = 'hdmi.cec';
const FEATURE_AUTO_STANDBY = 'system.autostandby';
const FEATURE_DRC = 'audio.drangecomp';
const FEATURE_AAV = 'audio.aav';
const FEATURE_MUTE = 'main.mute';
const FEATURE_HDMI_PASSTHROUGH = 'hdmi.passthrough';
const FEATURE_BLUETOOTH_MODE = 'bluetooth.mode';
const FEATURE_VERSION = 'system.version';
const FEATURE_NETWORK_MODE = 'network.mode';
const FEATURE_PRESET_VOL = 'main.presetvolstep';
const FEATURE_MAC_ADDRESS = 'network.macaddress';
const FEATURE_SW_LEVEL = 'level.sw';

// Constants
const DEFAULT_PORT = 33336;
const TCP_TIMEOUT = 10000; // 10 seconds
const CMD_ID_INITIAL = 10;
const CMD_ID_MAX = 1000000;
const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30000;

// Limits
const MIN_VOLUME = 0;
const MAX_VOLUME = 100;
const MIN_REAR_LEVEL = -10;
const MAX_REAR_LEVEL = 10;
const MIN_BASS_LEVEL = -10;
const MAX_BASS_LEVEL = 10;

class BraviaClient extends EventEmitter {
  constructor({ host, port = DEFAULT_PORT, logger = console }) {
    super();
    this.host = host;
    this.port = port;
    this.log = logger.log ? logger.log.bind(logger) : console.log;
    this.error = logger.error ? logger.error.bind(logger) : console.error;

    this._socket = null;
    this._connected = false;
    this._destroyed = false;
    this._buffer = '';

    // Command tracking
    this._commandId = CMD_ID_INITIAL;
    this._pendingResponses = new Map();
    this._commandQueue = Promise.resolve();

    // Reconnect
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._shouldReconnect = true;

    // Polling
    this._pollTimer = null;
    this._pollInterval = 60000; // 60s default

    // State cache
    this._state = {
      power: 'off',
      volume: 0,
      mute: 'off',
      input: 'tv',
      rearLevel: 0,
      bassLevel: 1,
      voiceEnhancer: 'upoff',
      soundField: 'off',
      nightMode: 'off',
      hdmiCec: 'off',
      autoStandby: 'off',
      drc: 'auto',
      aav: 'off',
      hdmiPassthrough: 'auto',
      bluetoothMode: 'off',
      version: '',
      networkMode: '',
    };
  }

  // --- Connection ---

  async connect() {
    if (this._connected || this._destroyed) return;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this._socket) {
          this._socket.destroy();
        }
        reject(new Error(`Connection timeout to ${this.host}:${this.port}`));
      }, TCP_TIMEOUT);

      this._socket = new net.Socket();

      this._socket.on('connect', () => {
        clearTimeout(timeout);
        this._connected = true;
        this._reconnectAttempts = 0;
        this._buffer = '';
        this.log(`Connected to Bravia at ${this.host}:${this.port}`);
        this.emit('connected');
        resolve();
      });

      this._socket.on('data', (data) => {
        this._onData(data);
      });

      this._socket.on('close', () => {
        clearTimeout(timeout);
        const wasConnected = this._connected;
        this._connected = false;
        this._failPendingResponses('Connection closed');
        if (wasConnected) {
          this.log('Connection closed');
          this.emit('disconnected');
          this._scheduleReconnect();
        }
      });

      this._socket.on('error', (err) => {
        clearTimeout(timeout);
        this.error('Socket error:', err.message);
        if (!this._connected) {
          reject(err);
        }
      });

      this._socket.connect(this.port, this.host);
    });
  }

  async disconnect() {
    this._shouldReconnect = false;
    this._stopPolling();
    this._clearReconnect();

    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
    this._connected = false;
    this._failPendingResponses('Disconnected');
  }

  async setHost(host) {
    if (this.host === host) return;
    await this.disconnect();
    this.host = host;
    this._shouldReconnect = true;
    this._reconnectAttempts = 0;
  }

  destroy() {
    this._destroyed = true;
    this.disconnect();
    this.removeAllListeners();
  }

  get isConnected() {
    return this._connected;
  }

  get state() {
    return { ...this._state };
  }

  // --- Commands ---

  async sendCommand(command) {
    if (!this._connected) {
      await this.connect();
    }

    // Serialize commands to avoid interleaving
    const result = await new Promise((resolveOuter, rejectOuter) => {
      this._commandQueue = this._commandQueue.then(async () => {
        const id = this._getNextCommandId();
        const cmd = { ...command, id };

        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this._pendingResponses.delete(id);
            reject(new Error(`Timeout waiting for response to command: ${JSON.stringify(cmd)}`));
          }, TCP_TIMEOUT);

          this._pendingResponses.set(id, { resolve, reject, timer });

          const json = JSON.stringify(cmd) + '\n';
          this._socket.write(json, (err) => {
            if (err) {
              clearTimeout(timer);
              this._pendingResponses.delete(id);
              reject(err);
            }
          });
        }).then(resolveOuter, rejectOuter);
      });
    });

    return result;
  }

  // --- Feature getters ---

  async getPower() {
    const resp = await this.sendCommand({ type: 'get', feature: FEATURE_POWER });
    if (resp && resp.type === 'result' && resp.feature === FEATURE_POWER) {
      this._updateState('power', resp.value);
    }
    return this._state.power;
  }

  async getVolume() {
    const resp = await this.sendCommand({ type: 'get', feature: FEATURE_VOLUME });
    if (resp && resp.type === 'result' && resp.feature === FEATURE_VOLUME) {
      const vol = parseInt(resp.value, 10);
      if (!isNaN(vol) && vol >= MIN_VOLUME && vol <= MAX_VOLUME) {
        this._updateState('volume', vol);
      }
    }
    return this._state.volume;
  }

  async getInput() {
    const resp = await this.sendCommand({ type: 'get', feature: FEATURE_INPUT });
    if (resp && resp.type === 'result' && resp.feature === FEATURE_INPUT) {
      this._updateState('input', resp.value);
    }
    return this._state.input;
  }

  async getRearLevel() {
    const resp = await this.sendCommand({ type: 'get', feature: FEATURE_REAR_LEVEL });
    if (resp && resp.type === 'result' && resp.feature === FEATURE_REAR_LEVEL) {
      const level = parseInt(resp.value, 10);
      if (!isNaN(level) && level >= MIN_REAR_LEVEL && level <= MAX_REAR_LEVEL) {
        this._updateState('rearLevel', level);
      }
    }
    return this._state.rearLevel;
  }

  async getBassLevel() {
    const resp = await this.sendCommand({ type: 'get', feature: FEATURE_BASS_LEVEL });
    if (resp && resp.type === 'result' && resp.feature === FEATURE_BASS_LEVEL) {
      const level = parseInt(resp.value, 10);
      if (!isNaN(level) && level >= MIN_BASS_LEVEL && level <= MAX_BASS_LEVEL) {
        this._updateState('bassLevel', level);
      }
    }
    return this._state.bassLevel;
  }

  async getVoiceEnhancer() {
    const resp = await this.sendCommand({ type: 'get', feature: FEATURE_VOICE_ENHANCER });
    if (resp && resp.type === 'result' && resp.feature === FEATURE_VOICE_ENHANCER) {
      this._updateState('voiceEnhancer', resp.value);
    }
    return this._state.voiceEnhancer;
  }

  async getSoundField() {
    const resp = await this.sendCommand({ type: 'get', feature: FEATURE_SOUND_FIELD });
    if (resp && resp.type === 'result' && resp.feature === FEATURE_SOUND_FIELD) {
      this._updateState('soundField', resp.value);
    }
    return this._state.soundField;
  }

  async getNightMode() {
    const resp = await this.sendCommand({ type: 'get', feature: FEATURE_NIGHT_MODE });
    if (resp && resp.type === 'result' && resp.feature === FEATURE_NIGHT_MODE) {
      this._updateState('nightMode', resp.value);
    }
    return this._state.nightMode;
  }

  async getHdmiCec() {
    const resp = await this.sendCommand({ type: 'get', feature: FEATURE_HDMI_CEC });
    if (resp && resp.type === 'result' && resp.feature === FEATURE_HDMI_CEC) {
      this._updateState('hdmiCec', resp.value);
    }
    return this._state.hdmiCec;
  }

  async getAutoStandby() {
    const resp = await this.sendCommand({ type: 'get', feature: FEATURE_AUTO_STANDBY });
    if (resp && resp.type === 'result' && resp.feature === FEATURE_AUTO_STANDBY) {
      this._updateState('autoStandby', resp.value);
    }
    return this._state.autoStandby;
  }

  async getDrc() {
    const resp = await this.sendCommand({ type: 'get', feature: FEATURE_DRC });
    if (resp && resp.type === 'result' && resp.feature === FEATURE_DRC) {
      this._updateState('drc', resp.value);
    }
    return this._state.drc;
  }

  async getAav() {
    const resp = await this.sendCommand({ type: 'get', feature: FEATURE_AAV });
    if (resp && resp.type === 'result' && resp.feature === FEATURE_AAV) {
      this._updateState('aav', resp.value);
    }
    return this._state.aav;
  }

  async getMute() {
    const resp = await this.sendCommand({ type: 'get', feature: FEATURE_MUTE });
    if (resp && resp.type === 'result' && resp.feature === FEATURE_MUTE) {
      this._updateState('mute', resp.value);
    }
    return this._state.mute;
  }

  async getHdmiPassthrough() {
    const resp = await this.sendCommand({ type: 'get', feature: FEATURE_HDMI_PASSTHROUGH });
    if (resp && resp.type === 'result' && resp.feature === FEATURE_HDMI_PASSTHROUGH) {
      this._updateState('hdmiPassthrough', resp.value);
    }
    return this._state.hdmiPassthrough;
  }

  async getBluetoothMode() {
    const resp = await this.sendCommand({ type: 'get', feature: FEATURE_BLUETOOTH_MODE });
    if (resp && resp.type === 'result' && resp.feature === FEATURE_BLUETOOTH_MODE) {
      this._updateState('bluetoothMode', resp.value);
    }
    return this._state.bluetoothMode;
  }

  async getVersion() {
    const resp = await this.sendCommand({ type: 'get', feature: FEATURE_VERSION });
    if (resp && resp.type === 'result' && resp.feature === FEATURE_VERSION) {
      this._updateState('version', resp.value);
    }
    return this._state.version;
  }

  async getNetworkMode() {
    const resp = await this.sendCommand({ type: 'get', feature: FEATURE_NETWORK_MODE });
    if (resp && resp.type === 'result' && resp.feature === FEATURE_NETWORK_MODE) {
      this._updateState('networkMode', resp.value);
    }
    return this._state.networkMode;
  }

  // --- Feature setters ---

  async setPower(value) {
    const resp = await this.sendCommand({ type: 'set', feature: FEATURE_POWER, value });
    return this._isAck(resp);
  }

  async setVolume(volume) {
    if (volume < MIN_VOLUME || volume > MAX_VOLUME) {
      throw new Error(`Volume must be between ${MIN_VOLUME} and ${MAX_VOLUME}`);
    }
    const resp = await this.sendCommand({ type: 'set', feature: FEATURE_VOLUME, value: volume });
    if (this._isAck(resp)) {
      this._updateState('volume', volume);
      return true;
    }
    return false;
  }

  async setInput(value) {
    const resp = await this.sendCommand({ type: 'set', feature: FEATURE_INPUT, value });
    if (this._isAck(resp)) {
      this._updateState('input', value);
      return true;
    }
    return false;
  }

  async setRearLevel(level) {
    if (level < MIN_REAR_LEVEL || level > MAX_REAR_LEVEL) {
      throw new Error(`Rear level must be between ${MIN_REAR_LEVEL} and ${MAX_REAR_LEVEL}`);
    }
    const resp = await this.sendCommand({ type: 'set', feature: FEATURE_REAR_LEVEL, value: level });
    if (this._isAck(resp)) {
      this._updateState('rearLevel', level);
      return true;
    }
    return false;
  }

  async setBassLevel(level) {
    if (level < MIN_BASS_LEVEL || level > MAX_BASS_LEVEL) {
      throw new Error(`Bass level must be between ${MIN_BASS_LEVEL} and ${MAX_BASS_LEVEL}`);
    }
    const resp = await this.sendCommand({ type: 'set', feature: FEATURE_BASS_LEVEL, value: level });
    if (this._isAck(resp)) {
      this._updateState('bassLevel', level);
      return true;
    }
    return false;
  }

  async setVoiceEnhancer(value) {
    const resp = await this.sendCommand({ type: 'set', feature: FEATURE_VOICE_ENHANCER, value });
    if (this._isAck(resp)) {
      this._updateState('voiceEnhancer', value);
      return true;
    }
    return false;
  }

  async setSoundField(value) {
    const resp = await this.sendCommand({ type: 'set', feature: FEATURE_SOUND_FIELD, value });
    if (this._isAck(resp)) {
      this._updateState('soundField', value);
      return true;
    }
    return false;
  }

  async setNightMode(value) {
    const resp = await this.sendCommand({ type: 'set', feature: FEATURE_NIGHT_MODE, value });
    if (this._isAck(resp)) {
      this._updateState('nightMode', value);
      return true;
    }
    return false;
  }

  async setHdmiCec(value) {
    const resp = await this.sendCommand({ type: 'set', feature: FEATURE_HDMI_CEC, value });
    if (this._isAck(resp)) {
      this._updateState('hdmiCec', value);
      return true;
    }
    return false;
  }

  async setAutoStandby(value) {
    const resp = await this.sendCommand({ type: 'set', feature: FEATURE_AUTO_STANDBY, value });
    if (this._isAck(resp)) {
      this._updateState('autoStandby', value);
      return true;
    }
    return false;
  }

  async setDrc(value) {
    const resp = await this.sendCommand({ type: 'set', feature: FEATURE_DRC, value });
    if (this._isAck(resp)) {
      this._updateState('drc', value);
      return true;
    }
    return false;
  }

  async setAav(value) {
    const resp = await this.sendCommand({ type: 'set', feature: FEATURE_AAV, value });
    if (this._isAck(resp)) {
      this._updateState('aav', value);
      return true;
    }
    return false;
  }

  async setMute(value) {
    const resp = await this.sendCommand({ type: 'set', feature: FEATURE_MUTE, value });
    if (this._isAck(resp)) {
      this._updateState('mute', value);
      return true;
    }
    return false;
  }

  async setHdmiPassthrough(value) {
    const resp = await this.sendCommand({ type: 'set', feature: FEATURE_HDMI_PASSTHROUGH, value });
    if (this._isAck(resp)) {
      this._updateState('hdmiPassthrough', value);
      return true;
    }
    return false;
  }

  async setBluetoothMode(value) {
    const resp = await this.sendCommand({ type: 'set', feature: FEATURE_BLUETOOTH_MODE, value });
    if (this._isAck(resp)) {
      this._updateState('bluetoothMode', value);
      return true;
    }
    return false;
  }

  async getPresetVolStep() {
    const resp = await this.sendCommand({ type: 'get', feature: FEATURE_PRESET_VOL });
    if (resp && resp.value !== undefined) {
      const val = resp.value === 'off' ? 0 : parseInt(resp.value, 10);
      if (!isNaN(val)) {
        this._updateState('presetVolStep', val);
        return val;
      }
    }
    return null;
  }

  async setPresetVolStep(value) {
    const payload = value === 0 ? 'off' : String(value);
    const resp = await this.sendCommand({ type: 'set', feature: FEATURE_PRESET_VOL, value: payload });
    if (this._isAck(resp)) {
      this._updateState('presetVolStep', value);
      return true;
    }
    return false;
  }

  async getMacAddress() {
    const resp = await this.sendCommand({ type: 'get', feature: FEATURE_MAC_ADDRESS });
    if (resp && resp.value !== undefined) {
      this._updateState('macAddress', resp.value);
      return resp.value;
    }
    return null;
  }

  // --- Fetch all states ---

  async fetchAllStates() {
    const fetchers = [
      () => this.getPower(),
      () => this.getVolume(),
      () => this.getMute(),
      () => this.getInput(),
      () => this.getRearLevel(),
      () => this.getBassLevel(),
      () => this.getVoiceEnhancer(),
      () => this.getSoundField(),
      () => this.getNightMode(),
      () => this.getHdmiCec(),
      () => this.getAutoStandby(),
      () => this.getDrc(),
      () => this.getAav(),
      () => this.getHdmiPassthrough(),
      () => this.getBluetoothMode(),
      () => this.getVersion(),
      () => this.getNetworkMode(),
      () => this.getPresetVolStep(),
      () => this.getMacAddress(),
    ];

    for (const fetch of fetchers) {
      try {
        await fetch();
      } catch (err) {
        this.error(`Failed to fetch state: ${err.message}`);
      }
    }

    this.log('All states fetched:', JSON.stringify(this._state));
  }

  // --- Subwoofer detection ---

  async detectSubwoofer() {
    const currentLevel = this._state.bassLevel;

    if (currentLevel < 0 || currentLevel > 2) {
      this.log(`Subwoofer detected: current bass level ${currentLevel} is outside 0-2 range`);
      return true;
    }

    try {
      const resp = await this.sendCommand({ type: 'set', feature: FEATURE_BASS_LEVEL, value: -5 });
      if (this._isAck(resp)) {
        this.log('Subwoofer detected: device accepted bass level -5');
        await this.sendCommand({ type: 'set', feature: FEATURE_BASS_LEVEL, value: currentLevel });
        this._updateState('bassLevel', currentLevel);
        return true;
      }
    } catch (err) {
      this.error(`Subwoofer detection error: ${err.message}`);
    }

    this.log('No subwoofer detected: device rejected bass level -5');
    return false;
  }

  // --- Volume limit fast-path ---

  setVolumeLimitCallback(callback) {
    this._volumeLimitCallback = callback;
  }

  // --- CIS-IP2 feature test ---

  async testCisIp2Features() {
    if (!this._connected) {
      await this.connect();
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const results = [];

    const get = async (feature) => {
      try {
        const resp = await this.sendCommand({ type: 'get', feature });
        if (resp && resp.type === 'result' && resp.value !== undefined && resp.value !== 'ERR' && resp.value !== 'err') {
          results.push({ feature, value: resp.value });
          this.log(`[CIS-IP2] ${feature} = ${JSON.stringify(resp.value)}`);
        } else {
          this.log(`[CIS-IP2] ${feature} → ERR / not supported`);
        }
      } catch (_) {
        this.log(`[CIS-IP2] ${feature} → timeout`);
      }
      await sleep(80);
    };

    this.log('=== CIS-IP2 feature test: main.* extras ===');
    await get('main.volumedb');
    await get('main.presetvolstep');
    await get('main.presetvoldb');
    await get('main.volume+');
    await get('main.volume-');

    this.log('=== CIS-IP2 feature test: system.* ===');
    await get('system.volumedisplay');
    await get('system.modeltype');
    await get('system.version');
    await get('system.sleep');
    await get('system.autoStandby');
    await get('system.quickstart');
    await get('system.remotestart');
    await get('system.dimmer');
    await get('system.language');
    await get('system.settingslock');
    await get('system.externalcontrol');
    await get('system.sircsmode');
    await get('system.autodisplay');

    this.log('=== CIS-IP2 feature test: audio.* ===');
    await get('audio.soundfield');
    await get('audio.soundoptimizer');
    await get('audio.dll');
    await get('audio.puredirect');
    await get('audio.drangecomp');
    await get('audio.dualmono');
    await get('audio.hddcstype');
    await get('audio.inceilingmode');

    this.log('=== CIS-IP2 feature test: hdmi.* ===');
    await get('hdmi.out');
    await get('hdmi.out2');
    await get('hdmi.passthrough');
    await get('hdmi.cec');
    await get('hdmi.audioout');
    await get('hdmi.4kscaling');
    await get('hdmi.fastview');
    await get('hdmi.swlevel');
    await get('hdmi.zone2audioout');
    await get('hdmi.zonepriority');

    this.log('=== CIS-IP2 feature test: network.* ===');
    await get('network.macaddress');
    await get('network.dhcp');
    await get('network.ipaddress');
    await get('network.subnetmask');
    await get('network.gateway');
    await get('network.dns1');
    await get('network.dns2');
    await get('network.standby');

    this.log('=== CIS-IP2 feature test: level.* (per-speaker trim) ===');
    for (const ch of ['FL', 'FR', 'CR', 'SL', 'SR', 'SB', 'SW']) {
      await get(`level.${ch}`);
    }

    this.log('=== CIS-IP2 feature test: distance.* (speaker distances) ===');
    for (const ch of ['FL', 'FR', 'CR', 'SL', 'SR', 'SB', 'SW']) {
      await get(`distance.${ch}`);
    }

    this.log('=== CIS-IP2 feature test: size.* / speaker.* ===');
    await get('size.front');
    await get('size.center');
    await get('size.surround');
    await get('speaker.out');
    await get('speaker.pattern');
    await get('speaker.apm');
    await get('speaker.distanceunit');
    await get('speaker.calibrationtype');

    this.log('=== CIS-IP2 feature test: bass.* / treble.* ===');
    for (const ch of ['front', 'center', 'surround']) {
      await get(`bass.${ch}`);
      await get(`treble.${ch}`);
    }

    this.log('=== CIS-IP2 feature test: zone2.* ===');
    await get('zone2.power');
    await get('zone2.volumestep');
    await get('zone2.input');
    await get('zone2.mute');

    this.log('=== CIS-IP2 feature test: custompreset.* ===');
    await get('custompreset1.import');
    await get('custompreset1.select');

    this.log(`=== CIS-IP2 test complete: ${results.length} supported features ===`);
    this.log('Supported:', JSON.stringify(results.map((r) => `${r.feature}=${JSON.stringify(r.value)}`)));

    return results;
  }

  // --- Test connection ---

  async testConnection() {
    try {
      if (!this._connected) {
        await this.connect();
      }
      await this.getPower();
      return true;
    } catch (err) {
      this.error(`Test connection failed: ${err.message}`);
      return false;
    }
  }

  // --- Polling (for DRC and AAV) ---

  startPolling(interval) {
    this._pollInterval = interval || this._pollInterval;
    this._stopPolling();
    this._pollTimer = setInterval(async () => {
      try {
        await this.getDrc();
        await this.getAav();
      } catch (err) {
        this.error(`Polling error: ${err.message}`);
      }
    }, this._pollInterval);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // --- Internal ---

  _onData(data) {
    this._buffer += data.toString('utf-8');

    // Parse all complete JSON objects from buffer
    let startIdx = 0;
    while (startIdx < this._buffer.length) {
      // Skip whitespace
      while (startIdx < this._buffer.length && /\s/.test(this._buffer[startIdx])) {
        startIdx++;
      }
      if (startIdx >= this._buffer.length) break;

      try {
        // Try to parse a JSON object starting at startIdx
        const sub = this._buffer.substring(startIdx);
        const parsed = this._tryParseJson(sub);
        if (parsed) {
          this._processMessage(parsed.obj);
          startIdx += parsed.end;
        } else {
          // Incomplete JSON, keep in buffer
          break;
        }
      } catch (err) {
        this.error(`JSON parse error: ${err.message}`);
        // Skip to next newline or end
        const nl = this._buffer.indexOf('\n', startIdx);
        if (nl === -1) {
          startIdx = this._buffer.length;
        } else {
          startIdx = nl + 1;
        }
      }
    }

    this._buffer = this._buffer.substring(startIdx);
  }

  _tryParseJson(str) {
    try {
      // Find the end of a JSON object by counting braces
      let depth = 0;
      let inString = false;
      let escape = false;

      for (let i = 0; i < str.length; i++) {
        const ch = str[i];

        if (escape) {
          escape = false;
          continue;
        }

        if (ch === '\\' && inString) {
          escape = true;
          continue;
        }

        if (ch === '"') {
          inString = !inString;
          continue;
        }

        if (inString) continue;

        if (ch === '{') depth++;
        if (ch === '}') {
          depth--;
          if (depth === 0) {
            const jsonStr = str.substring(0, i + 1);
            const obj = JSON.parse(jsonStr);
            return { obj, end: i + 1 };
          }
        }
      }

      return null; // Incomplete
    } catch (err) {
      return null;
    }
  }

  _processMessage(message) {
    if (!message) return;

    const { type, feature, value, id } = message;

    // Resolve pending command response
    if (type === 'result' && id != null) {
      const pending = this._pendingResponses.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this._pendingResponses.delete(id);
        pending.resolve(message);
      }
    }

    // Update internal state (skip ACK values)
    if (feature && value !== undefined && !(typeof value === 'string' && value.toUpperCase() === 'ACK')) {
      this._updateStateFromFeature(feature, value);
    }

    // Emit notifications and non-ACK results
    if (type === 'notify' || (type === 'result' && value !== undefined && !(typeof value === 'string' && value.toUpperCase() === 'ACK'))) {
      this.emit('notify', { feature, value });
      if (feature) {
        this.emit(`notify:${feature}`, value);
      }
    }

    // Fast-path: volume limit enforcement (fires before normal event chain)
    if (feature === FEATURE_VOLUME && this._volumeLimitCallback) {
      const vol = parseInt(value, 10);
      if (!isNaN(vol)) {
        this._volumeLimitCallback(vol);
      }
    }

    // Workaround: re-fetch input on power-on (device doesn't send input notification on wake)
    if (type === 'notify' && feature === FEATURE_POWER && value === 'on') {
      this.log('Power on detected, re-fetching input state');
      this.getInput().catch((err) => this.error(`Failed to re-fetch input: ${err.message}`));
    }
  }

  _updateStateFromFeature(feature, value) {
    const featureMap = {
      [FEATURE_POWER]: 'power',
      [FEATURE_VOLUME]: 'volume',
      [FEATURE_MUTE]: 'mute',
      [FEATURE_INPUT]: 'input',
      [FEATURE_REAR_LEVEL]: 'rearLevel',
      [FEATURE_BASS_LEVEL]: 'bassLevel',
      [FEATURE_VOICE_ENHANCER]: 'voiceEnhancer',
      [FEATURE_SOUND_FIELD]: 'soundField',
      [FEATURE_NIGHT_MODE]: 'nightMode',
      [FEATURE_HDMI_CEC]: 'hdmiCec',
      [FEATURE_AUTO_STANDBY]: 'autoStandby',
      [FEATURE_DRC]: 'drc',
      [FEATURE_AAV]: 'aav',
      [FEATURE_HDMI_PASSTHROUGH]: 'hdmiPassthrough',
      [FEATURE_BLUETOOTH_MODE]: 'bluetoothMode',
      [FEATURE_VERSION]: 'version',
      [FEATURE_NETWORK_MODE]: 'networkMode',
    };

    const stateKey = featureMap[feature];
    if (!stateKey) return;

    // Parse numeric values
    if (['volume', 'rearLevel', 'bassLevel'].includes(stateKey)) {
      const num = parseInt(value, 10);
      if (!isNaN(num)) {
        this._updateState(stateKey, num);
      }
    } else {
      this._updateState(stateKey, String(value));
    }
  }

  _updateState(key, value) {
    const oldValue = this._state[key];
    if (oldValue !== value) {
      this._state[key] = value;
      this.emit('stateChanged', { key, value, oldValue });
      this.emit(`stateChanged:${key}`, value, oldValue);
    }
  }

  _isAck(resp) {
    return resp && resp.type === 'result' && typeof resp.value === 'string' && resp.value.toUpperCase() === 'ACK';
  }

  _getNextCommandId() {
    this._commandId++;
    if (this._commandId > CMD_ID_MAX) {
      this._commandId = CMD_ID_INITIAL;
    }
    return this._commandId;
  }

  _failPendingResponses(reason) {
    for (const [id, pending] of this._pendingResponses) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this._pendingResponses.clear();
  }

  // --- Reconnect ---

  _scheduleReconnect() {
    if (!this._shouldReconnect || this._destroyed) return;

    this._clearReconnect();
    const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, this._reconnectAttempts), RECONNECT_MAX_DELAY);
    this._reconnectAttempts++;

    this.log(`Scheduling reconnect in ${delay}ms (attempt ${this._reconnectAttempts})`);

    this._reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        // Re-fetch all states after reconnect
        await this.fetchAllStates();
      } catch (err) {
        this.error(`Reconnect failed: ${err.message}`);
        this._scheduleReconnect();
      }
    }, delay);
  }

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }
}

// Export constants alongside the class
BraviaClient.FEATURES = {
  POWER: FEATURE_POWER,
  VOLUME: FEATURE_VOLUME,
  MUTE: FEATURE_MUTE,
  INPUT: FEATURE_INPUT,
  REAR_LEVEL: FEATURE_REAR_LEVEL,
  BASS_LEVEL: FEATURE_BASS_LEVEL,
  VOICE_ENHANCER: FEATURE_VOICE_ENHANCER,
  SOUND_FIELD: FEATURE_SOUND_FIELD,
  NIGHT_MODE: FEATURE_NIGHT_MODE,
  HDMI_CEC: FEATURE_HDMI_CEC,
  AUTO_STANDBY: FEATURE_AUTO_STANDBY,
  DRC: FEATURE_DRC,
  AAV: FEATURE_AAV,
  HDMI_PASSTHROUGH: FEATURE_HDMI_PASSTHROUGH,
  BLUETOOTH_MODE: FEATURE_BLUETOOTH_MODE,
  VERSION: FEATURE_VERSION,
  NETWORK_MODE: FEATURE_NETWORK_MODE,
};

BraviaClient.LIMITS = {
  MIN_VOLUME,
  MAX_VOLUME,
  MIN_REAR_LEVEL,
  MAX_REAR_LEVEL,
  MIN_BASS_LEVEL,
  MAX_BASS_LEVEL,
};

BraviaClient.DEFAULT_PORT = DEFAULT_PORT;

module.exports = BraviaClient;
