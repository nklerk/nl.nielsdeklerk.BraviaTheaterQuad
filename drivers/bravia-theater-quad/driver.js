'use strict';

const Homey = require('homey');
const BraviaClient = require('../../lib/BraviaClient');

class BraviaTheaterQuadDriver extends Homey.Driver {

  async onInit() {
    this.log('BraviaTheaterQuadDriver has been initialized');

    // Register flow card action listeners
    this._registerFlowCards();
  }

  _registerFlowCards() {
    // Set volume limit mode
    this.homey.flow.getActionCard('set_volume_limit_mode')
      .registerRunListener(async (args) => {
        await args.device.setSettings({ volume_limit_mode: args.mode });
        await args.device.onSettings({
          oldSettings: args.device.getSettings(),
          newSettings: { ...args.device.getSettings(), volume_limit_mode: args.mode },
          changedKeys: ['volume_limit_mode'],
        });
      });

    // Set volume limit value
    this.homey.flow.getActionCard('set_volume_limit_value')
      .registerRunListener(async (args) => {
        await args.device.setSettings({ volume_limit_max: args.volume });
        await args.device.onSettings({
          oldSettings: args.device.getSettings(),
          newSettings: { ...args.device.getSettings(), volume_limit_max: args.volume },
          changedKeys: ['volume_limit_max'],
        });
      });

    // Volume up by steps
    this.homey.flow.getActionCard('volume_up_by')
      .registerRunListener(async (args) => {
        await args.device.volumeUpBy(args.steps);
      });

    // Volume down by steps
    this.homey.flow.getActionCard('volume_down_by')
      .registerRunListener(async (args) => {
        await args.device.volumeDownBy(args.steps);
      });

    // Set input source
    this.homey.flow.getActionCard('set_input')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('bravia_input', args.input);
      });

    // Set DRC mode
    this.homey.flow.getActionCard('set_drc')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('bravia_drc', args.mode);
      });

    // Set HDMI passthrough
    this.homey.flow.getActionCard('set_hdmi_passthrough')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('bravia_hdmi_passthrough', args.mode);
      });

    // Voice enhancer on/off
    this.homey.flow.getActionCard('turn_voice_enhancer_on')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('bravia_voice_enhancer', true);
      });
    this.homey.flow.getActionCard('turn_voice_enhancer_off')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('bravia_voice_enhancer', false);
      });

    // Sound field on/off
    this.homey.flow.getActionCard('turn_sound_field_on')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('bravia_sound_field', true);
      });
    this.homey.flow.getActionCard('turn_sound_field_off')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('bravia_sound_field', false);
      });

    // Night mode on/off
    this.homey.flow.getActionCard('turn_night_mode_on')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('bravia_night_mode', true);
      });
    this.homey.flow.getActionCard('turn_night_mode_off')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('bravia_night_mode', false);
      });

    // Input is condition
    this.homey.flow.getConditionCard('input_is')
      .registerRunListener(async (args) => {
        return args.device.getCapabilityValue('bravia_input') === args.input;
      });
  }

  async onPairListDevices() {
    const discoveryStrategy = this.getDiscoveryStrategy();
    const discoveryResults = discoveryStrategy.getDiscoveryResults();

    const devices = [];
    for (const [id, result] of Object.entries(discoveryResults)) {
      devices.push({
        name: result.txt?.model || result.name || 'Bravia Theater Quad',
        data: {
          id,
        },
        store: {
          address: result.address,
          port: BraviaClient.DEFAULT_PORT,
        },
        settings: {
          ip_address: result.address,
        },
      });
    }

    return devices;
  }

  async onPair(session) {
    let manualDevice = null;

    session.setHandler('showView', async (view) => {
      if (view === 'manual_ip') {
        // Manual IP view shown
      }
    });

    session.setHandler('manual_ip_entered', async (data) => {
      const { address } = data;

      // Validate by attempting a test connection
      const client = new BraviaClient({
        host: address,
        logger: this,
      });

      try {
        const success = await client.testConnection();
        if (!success) {
          throw new Error('Could not connect to device');
        }

        manualDevice = {
          name: 'Bravia Theater Quad',
          data: {
            id: `bravia-manual-${address.replace(/\./g, '-')}`,
          },
          store: {
            address,
            port: BraviaClient.DEFAULT_PORT,
          },
          settings: {
            ip_address: address,
          },
        };

        return manualDevice;
      } finally {
        client.destroy();
      }
    });

    session.setHandler('list_devices', async () => {
      if (manualDevice) {
        return [manualDevice];
      }
      return this.onPairListDevices();
    });
  }

}

module.exports = BraviaTheaterQuadDriver;
