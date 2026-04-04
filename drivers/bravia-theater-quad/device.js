'use strict';

const Homey = require('homey');
const BraviaClient = require('../../lib/BraviaClient');

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

    // Volume limit trigger card
    this._volumeLimitTrigger = this.homey.flow.getDeviceTriggerCard('volume_limit_reached');

    // Input changed trigger card
    this._inputChangedTrigger = this.homey.flow.getDeviceTriggerCard('input_changed');

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
        this._volumeLimitTrigger.trigger(this).catch(this.error);
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

    // Detect subwoofer
    const hasSubwoofer = await this._client.detectSubwoofer();
    await this._configureBassCapability(hasSubwoofer);
    await this.setSettings({ has_subwoofer: hasSubwoofer ? 'Yes' : 'No' }).catch(this.error);

    // Update device info settings
    const state = this._client.state;
    await this.setSettings({
      firmware_version: state.version || 'Unknown',
      network_mode: state.networkMode || 'Unknown',
      mac_address: state.macAddress || 'Unknown',
      startup_volume: state.presetVolStep != null ? state.presetVolStep : 0,
    }).catch(this.error);

    // Sync all states to Homey
    await this._syncAllStates();

    this.setAvailable().catch(this.error);
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
  }

  // --- State sync ---

  async _syncAllStates() {
    const state = this._client.state;

    await this._safeSetCapabilityValue('onoff', state.power === 'on');
    await this._safeSetCapabilityValue('volume_set', state.volume / 100);
    await this._safeSetCapabilityValue('bravia_input', state.input);
    await this._safeSetCapabilityValue('bravia_night_mode', state.nightMode === 'on');
    await this._safeSetCapabilityValue('bravia_voice_enhancer', state.voiceEnhancer === 'upon');
    await this._safeSetCapabilityValue('bravia_sound_field', state.soundField === 'on');
    await this._safeSetCapabilityValue('bravia_rear_level', state.rearLevel);
    await this._safeSetCapabilityValue('bravia_hdmi_cec', state.hdmiCec === 'on');
    await this._safeSetCapabilityValue('bravia_auto_standby', state.autoStandby === 'on');
    await this._safeSetCapabilityValue('bravia_drc', state.drc);
    await this._safeSetCapabilityValue('bravia_aav', state.aav === 'on');
    await this._safeSetCapabilityValue('volume_mute', state.mute === 'on');
    await this._safeSetCapabilityValue('bravia_hdmi_passthrough', state.hdmiPassthrough);
    await this._safeSetCapabilityValue('bravia_bluetooth_mode', state.bluetoothMode);

    // Bass level
    if (this._hasSubwoofer) {
      await this._safeSetCapabilityValue('bravia_bass_level', state.bassLevel);
    } else {
      await this._safeSetCapabilityValue('bravia_bass_select', String(state.bassLevel));
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
      this.setUnavailable('Device disconnected').catch(this.error);
    });

    // State changes from notifications
    this._client.on('stateChanged:power', (value) => {
      this._safeSetCapabilityValue('onoff', value === 'on');
    });

    this._client.on('stateChanged:volume', (value) => {
      this._safeSetCapabilityValue('volume_set', value / 100);
    });

    this._client.on('stateChanged:input', (value) => {
      this._safeSetCapabilityValue('bravia_input', value);
      this._inputChangedTrigger.trigger(this, { input: value }).catch(this.error);
    });

    this._client.on('stateChanged:rearLevel', (value) => {
      this._safeSetCapabilityValue('bravia_rear_level', value);
    });

    this._client.on('stateChanged:bassLevel', (value) => {
      if (this._hasSubwoofer) {
        this._safeSetCapabilityValue('bravia_bass_level', value);
      } else {
        this._safeSetCapabilityValue('bravia_bass_select', String(value));
      }
    });

    this._client.on('stateChanged:voiceEnhancer', (value) => {
      this._safeSetCapabilityValue('bravia_voice_enhancer', value === 'upon');
    });

    this._client.on('stateChanged:soundField', (value) => {
      this._safeSetCapabilityValue('bravia_sound_field', value === 'on');
    });

    this._client.on('stateChanged:nightMode', (value) => {
      this._safeSetCapabilityValue('bravia_night_mode', value === 'on');
    });

    this._client.on('stateChanged:hdmiCec', (value) => {
      this._safeSetCapabilityValue('bravia_hdmi_cec', value === 'on');
    });

    this._client.on('stateChanged:autoStandby', (value) => {
      this._safeSetCapabilityValue('bravia_auto_standby', value === 'on');
    });

    this._client.on('stateChanged:drc', (value) => {
      this._safeSetCapabilityValue('bravia_drc', value);
    });

    this._client.on('stateChanged:aav', (value) => {
      this._safeSetCapabilityValue('bravia_aav', value === 'on');
    });

    this._client.on('stateChanged:mute', (value) => {
      this._safeSetCapabilityValue('volume_mute', value === 'on');
    });

    this._client.on('stateChanged:hdmiPassthrough', (value) => {
      this._safeSetCapabilityValue('bravia_hdmi_passthrough', value);
    });

    this._client.on('stateChanged:bluetoothMode', (value) => {
      this._safeSetCapabilityValue('bravia_bluetooth_mode', value);
    });
  }

  // --- Capability listeners ---

  _registerCapabilityListeners() {
    this.registerCapabilityListener('onoff', async (value) => {
      await this._client.setPower(value ? 'on' : 'off');
    });

    this.registerCapabilityListener('volume_set', async (value) => {
      const volume = this._applyVolumeLimit(Math.round(value * 100));
      await this._client.setVolume(volume);
    });

    this.registerCapabilityListener('bravia_input', async (value) => {
      await this._client.setInput(value);
    });

    this.registerCapabilityListener('bravia_night_mode', async (value) => {
      await this._client.setNightMode(value ? 'on' : 'off');
    });

    this.registerCapabilityListener('bravia_voice_enhancer', async (value) => {
      await this._client.setVoiceEnhancer(value ? 'upon' : 'upoff');
    });

    this.registerCapabilityListener('bravia_sound_field', async (value) => {
      await this._client.setSoundField(value ? 'on' : 'off');
    });

    this.registerCapabilityListener('bravia_rear_level', async (value) => {
      await this._client.setRearLevel(value);
    });

    // Bass level (subwoofer)
    if (this.hasCapability('bravia_bass_level')) {
      this.registerCapabilityListener('bravia_bass_level', async (value) => {
        await this._client.setBassLevel(value);
      });
    }

    // Bass select (no subwoofer)
    if (this.hasCapability('bravia_bass_select')) {
      this.registerCapabilityListener('bravia_bass_select', async (value) => {
        await this._client.setBassLevel(parseInt(value, 10));
      });
    }

    this.registerCapabilityListener('bravia_hdmi_cec', async (value) => {
      await this._client.setHdmiCec(value ? 'on' : 'off');
    });

    this.registerCapabilityListener('bravia_auto_standby', async (value) => {
      await this._client.setAutoStandby(value ? 'on' : 'off');
    });

    this.registerCapabilityListener('bravia_drc', async (value) => {
      await this._client.setDrc(value);
    });

    this.registerCapabilityListener('bravia_aav', async (value) => {
      await this._client.setAav(value ? 'on' : 'off');
    });

    this.registerCapabilityListener('volume_mute', async (value) => {
      await this._client.setMute(value ? 'on' : 'off');
    });

    this.registerCapabilityListener('bravia_hdmi_passthrough', async (value) => {
      await this._client.setHdmiPassthrough(value);
    });

    this.registerCapabilityListener('bravia_bluetooth_mode', async (value) => {
      await this._client.setBluetoothMode(value);
    });
  }

  // --- Volume limiter ---

  _getVolumeLimitMode() {
    return this.getSetting('volume_limit_mode') || 'disabled';
  }

  _getVolumeLimitMax() {
    return this.getSetting('volume_limit_max') || 100;
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
      this._volumeLimitTrigger.trigger(this).catch(this.error);

      // Enforce limit
      try {
        await this._client.setVolume(max);
        await this._safeSetCapabilityValue('volume_set', max / 100);
      } catch (err) {
        this.error('Failed to enforce volume limit:', err.message);
      }
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

      // If switching to active, immediately check current volume
      if (newSettings.volume_limit_mode === 'active') {
        const currentVolume = this._client.state.volume;
        await this._enforceVolumeLimit(currentVolume);
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

      // Reconnect with new address
      this._client.host = newAddress;
      await this._client.disconnect();
      this._client._shouldReconnect = true;
      try {
        await this._client.connect();
        await this._initializeDevice();
      } catch (err) {
        this.error('Failed to reconnect after address change:', err.message);
      }
    }

    this.setAvailable().catch(this.error);
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
    if (this._client) {
      this._client.destroy();
      this._client = null;
    }
  }

  async onUninit() {
    if (this._client) {
      this._client.destroy();
      this._client = null;
    }
  }
}

module.exports = BraviaTheaterQuadDevice;
