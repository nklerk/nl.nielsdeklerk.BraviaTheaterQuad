'use strict';

const Homey = require('homey');
const BraviaClient = require('../../lib/BraviaClient');

// Single source of truth for capability ↔ stateKey ↔ client method ↔ trigger.
// Each entry describes how to:
//   - decode(state)              → capability value
//   - set(client, value)         → push capability value to the device
//   - triggerOnChange(value)     → trigger card id (or null)
//   - triggerToken(value)        → token object for the trigger card
//   - when(device)               → only apply this entry when predicate is true (used for dynamic bass cap)
const CAPS = [
  {
    capability: 'onoff', stateKey: 'power',
    decode: (v) => v === 'on',
    set: (c, v) => c.setPower(v ? 'on' : 'off'),
    triggerOnChange: (v) => (v ? 'power_on' : 'power_off'),
  },
  {
    capability: 'volume_set', stateKey: 'volume',
    decode: (v) => v / 100,
    set: (c, v, device) => c.setVolume(device._applyVolumeLimit(Math.round(v * 100))),
  },
  {
    capability: 'volume_mute', stateKey: 'mute',
    decode: (v) => v === 'on',
    set: (c, v) => c.setMute(v ? 'on' : 'off'),
  },
  {
    capability: 'bravia_input', stateKey: 'input',
    decode: (v) => v,
    set: (c, v) => c.setInput(v),
    triggerOnChange: () => 'input_changed',
    triggerToken: (v) => ({ input: v }),
  },
  {
    capability: 'bravia_night_mode', stateKey: 'nightMode',
    decode: (v) => v === 'on',
    set: (c, v) => c.setNightMode(v ? 'on' : 'off'),
    triggerOnChange: (v) => (v ? 'night_mode_on' : 'night_mode_off'),
  },
  {
    capability: 'bravia_voice_enhancer', stateKey: 'voiceEnhancer',
    decode: (v) => v === 'upon',
    set: (c, v) => c.setVoiceEnhancer(v ? 'upon' : 'upoff'),
    triggerOnChange: (v) => (v ? 'voice_enhancer_on' : 'voice_enhancer_off'),
  },
  {
    capability: 'bravia_sound_field', stateKey: 'soundField',
    decode: (v) => v === 'on',
    set: (c, v) => c.setSoundField(v ? 'on' : 'off'),
    triggerOnChange: (v) => (v ? 'sound_field_on' : 'sound_field_off'),
  },
  {
    capability: 'bravia_rear_level', stateKey: 'rearLevel',
    decode: (v) => v,
    set: (c, v) => c.setRearLevel(v),
    triggerOnChange: () => 'rear_level_changed',
    triggerToken: (v) => ({ level: v }),
  },
  {
    capability: 'bravia_hdmi_cec', stateKey: 'hdmiCec',
    decode: (v) => v === 'on',
    set: (c, v) => c.setHdmiCec(v ? 'on' : 'off'),
    triggerOnChange: (v) => (v ? 'hdmi_cec_on' : 'hdmi_cec_off'),
  },
  {
    capability: 'bravia_auto_standby', stateKey: 'autoStandby',
    decode: (v) => v === 'on',
    set: (c, v) => c.setAutoStandby(v ? 'on' : 'off'),
    triggerOnChange: (v) => (v ? 'auto_standby_on' : 'auto_standby_off'),
  },
  {
    capability: 'bravia_drc', stateKey: 'drc',
    decode: (v) => v,
    set: (c, v) => c.setDrc(v),
    triggerOnChange: () => 'drc_changed',
    triggerToken: (v) => ({ mode: v }),
  },
  {
    capability: 'bravia_aav', stateKey: 'aav',
    decode: (v) => v === 'on',
    set: (c, v) => c.setAav(v ? 'on' : 'off'),
    triggerOnChange: (v) => (v ? 'aav_on' : 'aav_off'),
  },
  {
    capability: 'bravia_hdmi_passthrough', stateKey: 'hdmiPassthrough',
    decode: (v) => v,
    set: (c, v) => c.setHdmiPassthrough(v),
    triggerOnChange: () => 'hdmi_passthrough_changed',
    triggerToken: (v) => ({ mode: v }),
  },
  {
    capability: 'bravia_bluetooth_mode', stateKey: 'bluetoothMode',
    decode: (v) => v,
    set: (c, v) => c.setBluetoothMode(v),
    triggerOnChange: () => 'bluetooth_mode_changed',
    triggerToken: (v) => ({ mode: v }),
  },
  {
    capability: 'bravia_bass_level', stateKey: 'bassLevel',
    when: (d) => d._hasSubwoofer === true,
    decode: (v) => v,
    set: (c, v) => c.setBassLevel(v),
    triggerOnChange: () => 'bass_level_changed',
    triggerToken: (v) => ({ level: v }),
  },
  {
    capability: 'bravia_bass_select', stateKey: 'bassLevel',
    when: (d) => d._hasSubwoofer === false,
    decode: (v) => String(v),
    set: (c, v) => c.setBassLevel(parseInt(v, 10)),
    triggerOnChange: () => 'bass_level_changed',
    triggerToken: (v) => ({ level: parseInt(v, 10) }),
  },
];

const TRIGGER_IDS = [
  'volume_limit_reached', 'input_changed',
  'power_on', 'power_off',
  'night_mode_on', 'night_mode_off',
  'voice_enhancer_on', 'voice_enhancer_off',
  'sound_field_on', 'sound_field_off',
  'hdmi_cec_on', 'hdmi_cec_off',
  'auto_standby_on', 'auto_standby_off',
  'aav_on', 'aav_off',
  'drc_changed', 'hdmi_passthrough_changed', 'bluetooth_mode_changed',
  'rear_level_changed', 'bass_level_changed',
];

class BraviaTheaterQuadDevice extends Homey.Device {
  async onInit() {
    this.log('BraviaTheaterQuadDevice has been initialized');

    const store = this.getStore();
    const settings = this.getSettings();

    // Create client
    this._client = new BraviaClient({
      host: store.address,
      port: store.port || BraviaClient.DEFAULT_PORT,
      logger: this,
    });

    // Cache all trigger card refs in a single map
    this._triggers = {};
    for (const id of TRIGGER_IDS) {
      this._triggers[id] = this.homey.flow.getDeviceTriggerCard(id);
    }

    // Fast-path volume limit: fires directly from _processMessage in BraviaClient
    // This is the fastest possible enforcement — before the normal event chain
    this._volumeLimitEnforcing = false;
    this._client.setVolumeLimitCallback((currentVolume) => {
      const mode = this.getSetting('volume_limit_mode') || 'disabled';
      if (mode !== 'active') return;

      const max = this.getSetting('volume_limit_max') || 100;
      if (currentVolume > max && !this._volumeLimitEnforcing) {
        this._volumeLimitEnforcing = true;
        this.log(`[FAST-PATH] Volume ${currentVolume} exceeds limit ${max}, enforcing immediately`);
        this._triggers.volume_limit_reached.trigger(this).catch(this.error);
        this._client
          .setVolume(max)
          .then(() => this._safeSetCapabilityValue('volume_set', max / 100))
          .catch((err) => this.error('Fast-path volume limit error:', err.message))
          .finally(() => {
            this._volumeLimitEnforcing = false;
          });
      }
    });

    // Connect and initialize
    try {
      await this._client.connect();
      await this._initializeDevice();
    } catch (err) {
      this.error('Failed to initialize device:', err.message);
      // Client will auto-reconnect; set unavailable until reconnected
      this.setUnavailable(err.message).catch(this.error);
    }

    // Register event listeners
    this._registerClientEvents();
    this._registerCapabilityListeners();

    // Start polling for DRC and AAV
    const pollInterval = (settings.poll_interval || 60) * 1000;
    this._client.startPolling(pollInterval);
  }

  async _initializeDevice() {
    // Fetch all states
    await this._client.fetchAllStates();

    // Detect External Control disabled: all get commands return 'ERR'
    if (this._client.state.power === 'ERR') {
      const msg = this.homey.__('errors.external_control_disabled');
      this.log('External Control is disabled, marking device unavailable');
      this.setUnavailable(msg).catch(this.error);
      this._startExternalControlRecovery();
      return;
    }

    // Clear any running recovery loop now that initialization succeeded
    this._stopExternalControlRecovery();

    // Detect optional subwoofer (no sub: bass range 0-2, with sub: bass range -10 to 10)
    const hasSubwoofer = await this._client.detectSubwoofer();
    await this._configureBassCapability(hasSubwoofer);
    const yesNo = hasSubwoofer ? this.homey.__('labels.yes') : this.homey.__('labels.no');
    await this.setSettings({ has_subwoofer: yesNo }).catch(this.error);

    // Update device info settings
    const state = this._client.state;
    await this.setSettings({
      firmware_version: state.version || 'Unknown',
      network_mode: state.networkMode || 'Unknown',
      mac_address: state.macAddress || 'Unknown',
      startup_volume: state.presetVolStep != null ? state.presetVolStep : 0,
    }).catch(this.error);

    // Apply volume slider limit
    this._updateVolumeSliderLimit();

    // Sync all states to Homey
    await this._syncAllStates();

    this.setAvailable().catch(this.error);
  }

  // --- External Control recovery ---

  _startExternalControlRecovery() {
    if (this._recoveryTimer) return;
    this.log('Starting External Control recovery polling (every 30s)');
    this._recoveryTimer = setInterval(async () => {
      try {
        const power = await this._client.getPower();
        if (power !== 'ERR') {
          this._stopExternalControlRecovery();
          this.log('External Control re-enabled, reinitializing device');
          await this._initializeDevice();
        }
      } catch (err) {
        // Still unreachable or ERR — keep waiting
      }
    }, 30000);
  }

  _stopExternalControlRecovery() {
    if (this._recoveryTimer) {
      clearInterval(this._recoveryTimer);
      this._recoveryTimer = null;
    }
  }

  // --- Bass capability configuration ---

  async _configureBassCapability(hasSubwoofer) {
    this._hasSubwoofer = hasSubwoofer;

    if (hasSubwoofer) {
      // Add bass slider, remove picker if present
      if (!this.hasCapability('bravia_bass_level')) {
        await this.addCapability('bravia_bass_level');
      }
      if (this.hasCapability('bravia_bass_select')) {
        await this.removeCapability('bravia_bass_select');
      }
    } else {
      // Add bass picker, remove slider if present
      if (!this.hasCapability('bravia_bass_select')) {
        await this.addCapability('bravia_bass_select');
      }
      if (this.hasCapability('bravia_bass_level')) {
        await this.removeCapability('bravia_bass_level');
      }
    }

    // Register the listener for whichever bass capability is now active.
    // (Capability listener registration is idempotent per capability instance,
    // but the cap may have been added after onInit, so we (re-)register here.)
    this._registerBassListener();
  }

  _registerBassListener() {
    if (this._bassListenerRegistered) return;
    const bassCap = CAPS.find((c) => c.stateKey === 'bassLevel' && c.when && c.when(this) && this.hasCapability(c.capability));
    if (!bassCap) return;
    this.registerCapabilityListener(bassCap.capability, async (value) => {
      await bassCap.set(this._client, value, this);
    });
    this._bassListenerRegistered = true;
  }

  // --- State sync ---

  _capsForDevice() {
    return CAPS.filter((cap) => (cap.when ? cap.when(this) : true));
  }

  async _syncAllStates() {
    const state = this._client.state;
    for (const cap of this._capsForDevice()) {
      const raw = state[cap.stateKey];
      if (raw === undefined || raw === null) continue;
      await this._safeSetCapabilityValue(cap.capability, cap.decode(raw));
    }
  }

  async _safeSetCapabilityValue(capability, value) {
    if (this.hasCapability(capability) && value !== undefined && value !== null) {
      try {
        await this.setCapabilityValue(capability, value);
      } catch (err) {
        this.error(`Failed to set ${capability}:`, err.message);
      }
    }
  }

  // --- Client events ---

  _registerClientEvents() {
    this._client.on('connected', () => {
      this.log('Client connected');
      this.setAvailable().catch(this.error);
    });

    this._client.on('disconnected', () => {
      this.log('Client disconnected');
      this.setUnavailable(this.homey.__('errors.disconnected')).catch(this.error);
    });

    // Group CAPS by stateKey so we register exactly one listener per state key
    const byStateKey = new Map();
    for (const cap of CAPS) {
      if (!byStateKey.has(cap.stateKey)) byStateKey.set(cap.stateKey, []);
      byStateKey.get(cap.stateKey).push(cap);
    }

    for (const [stateKey, caps] of byStateKey) {
      this._client.on(`stateChanged:${stateKey}`, (value) => {
        // Apply each cap whose `when` predicate matches; emit at most one trigger per fired event
        const firedTriggers = new Set();
        for (const cap of caps) {
          if (cap.when && !cap.when(this)) continue;
          const decoded = cap.decode(value);
          this._safeSetCapabilityValue(cap.capability, decoded);
          if (cap.triggerOnChange) {
            const triggerId = cap.triggerOnChange(decoded);
            if (triggerId && !firedTriggers.has(triggerId)) {
              firedTriggers.add(triggerId);
              const tokens = cap.triggerToken ? cap.triggerToken(decoded) : undefined;
              const card = this._triggers[triggerId];
              if (card) card.trigger(this, tokens).catch(this.error);
            }
          }
        }
      });
    }
  }

  // --- Capability listeners ---

  _registerCapabilityListeners() {
    // Register a listener for every CAP that does NOT depend on the dynamic bass
    // detection. Bass listeners are registered separately from _configureBassCapability.
    for (const cap of CAPS) {
      if (cap.when) continue; // dynamic; handled by _registerBassListener
      if (!this.hasCapability(cap.capability)) continue;
      this.registerCapabilityListener(cap.capability, async (value) => {
        await cap.set(this._client, value, this);
      });
    }
    // Bass listener (in case _configureBassCapability already ran and added the cap)
    this._registerBassListener();
  }

  // --- Volume limiter ---

  _getVolumeLimitMode() {
    return this.getSetting('volume_limit_mode') || 'disabled';
  }

  _getVolumeLimitMax() {
    return this.getSetting('volume_limit_max') || 100;
  }

  _updateVolumeSliderLimit(settings) {
    const mode = settings ? settings.volume_limit_mode : this._getVolumeLimitMode();
    const max = settings ? (settings.volume_limit_max || 100) : this._getVolumeLimitMax();
    const sliderMax = mode !== 'disabled' ? max / 100 : 1;
    this.setCapabilityOptions('volume_set', { max: sliderMax }).catch(this.error);
  }

  _applyVolumeLimit(volume) {
    const mode = this._getVolumeLimitMode();
    if (mode === 'disabled') return volume;

    const max = this._getVolumeLimitMax();
    if (volume > max) {
      return max;
    }
    return volume;
  }

  async _enforceVolumeLimit(currentVolume) {
    const mode = this._getVolumeLimitMode();
    if (mode !== 'active') return;

    const max = this._getVolumeLimitMax();
    if (currentVolume > max) {
      this.log(`Active volume limit: volume ${currentVolume} exceeds limit ${max}, enforcing`);

      // Trigger flow card
      this._triggers.volume_limit_reached.trigger(this).catch(this.error);

      // Enforce limit
      try {
        await this._client.setVolume(max);
        await this._safeSetCapabilityValue('volume_set', max / 100);
      } catch (err) {
        this.error('Failed to enforce volume limit:', err.message);
      }
    }
  }

  // Public helper used by both onSettings and the volume-limit flow actions to
  // apply the side-effects of a volume-limit change without re-entering onSettings.
  applyVolumeLimitSettings() {
    this._updateVolumeSliderLimit();
    if (this._getVolumeLimitMode() === 'active') {
      this._enforceVolumeLimit(this._client.state.volume).catch(this.error);
    }
  }

  // --- Volume step helpers (for flow cards) ---

  async volumeUpBy(steps) {
    const currentVolume = this._client.state.volume;
    const newVolume = this._applyVolumeLimit(Math.min(currentVolume + steps, 100));
    await this._client.setVolume(newVolume);
  }

  async volumeDownBy(steps) {
    const currentVolume = this._client.state.volume;
    const newVolume = Math.max(currentVolume - steps, 0);
    await this._client.setVolume(newVolume);
  }

  // --- Settings ---

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('poll_interval')) {
      const interval = (newSettings.poll_interval || 60) * 1000;
      this._client.startPolling(interval);
      this.log(`Poll interval updated to ${newSettings.poll_interval}s`);
    }

    if (changedKeys.includes('volume_limit_mode') || changedKeys.includes('volume_limit_max')) {
      this.log(`Volume limit updated: mode=${newSettings.volume_limit_mode}, max=${newSettings.volume_limit_max}`);

      // Update slider max + enforce if active. We pass newSettings to the slider helper
      // because Homey hasn't persisted them yet at this point.
      this._updateVolumeSliderLimit(newSettings);
      if (newSettings.volume_limit_mode === 'active') {
        await this._enforceVolumeLimit(this._client.state.volume);
      }
    }

    if (changedKeys.includes('startup_volume')) {
      const vol = newSettings.startup_volume != null ? newSettings.startup_volume : 0;
      await this._client.setPresetVolStep(vol);
      this.log(`Startup volume updated to ${vol === 0 ? 'off' : vol}`);
    }

  }

  // --- Discovery ---

  onDiscoveryResult(discoveryResult) {
    return discoveryResult.id === this.getData().id;
  }

  async onDiscoveryAvailable(discoveryResult) {
    const newAddress = discoveryResult.address;
    const store = this.getStore();

    if (store.address !== newAddress) {
      this.log(`Discovery: address changed from ${store.address} to ${newAddress}`);
      await this.setStoreValue('address', newAddress);
      await this.setSettings({ ip_address: newAddress }).catch(this.error);

      try {
        await this._client.setHost(newAddress);
        await this._client.connect();
        await this._initializeDevice();
      } catch (err) {
        this.error('Failed to reconnect after address change:', err.message);
      }
      // _initializeDevice handles setAvailable / setUnavailable on its own
      return;
    }

    // Address unchanged — only mark available if we're not stuck on External Control disabled
    if (this._client && this._client.state.power !== 'ERR') {
      this.setAvailable().catch(this.error);
    }
  }

  onDiscoveryAddressChanged(discoveryResult) {
    this.onDiscoveryAvailable(discoveryResult);
  }

  onDiscoveryLastSeenChanged(discoveryResult) {
    // No action needed
  }

  // --- Cleanup ---

  async onDeleted() {
    this.log('Device deleted, cleaning up');
    this._stopExternalControlRecovery();
    if (this._client) {
      this._client.destroy();
      this._client = null;
    }
  }

  async onUninit() {
    this.log('Device uninit, cleaning up');
    this._stopExternalControlRecovery();
    if (this._client) {
      this._client.destroy();
      this._client = null;
    }
  }
}

module.exports = BraviaTheaterQuadDevice;
