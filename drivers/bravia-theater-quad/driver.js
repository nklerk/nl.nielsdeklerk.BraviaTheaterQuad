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
    const action = (id, fn) => this.homey.flow.getActionCard(id).registerRunListener(fn);
    const condition = (id, fn) => this.homey.flow.getConditionCard(id).registerRunListener(fn);

    // Helper: invoke a capability listener so the device actually pushes the change to the Bravia
    const setCap = (device, capability, value) => device.triggerCapabilityListener(capability, value);
    const boolAction = (id, capability, value) => action(id, async ({ device }) => setCap(device, capability, value));
    const enumAction = (id, capability, argName = 'mode') => action(id, async (args) => setCap(args.device, capability, args[argName]));
    const boolCondition = (id, capability) => condition(id, async ({ device }) => device.getCapabilityValue(capability) === true);
    const enumCondition = (id, capability, argName = 'mode') => condition(id, async (args) => args.device.getCapabilityValue(capability) === args[argName]);

    // --- Settings-driven actions ---
    action('set_volume_limit_mode', async (args) => {
      await args.device.setSettings({ volume_limit_mode: args.mode });
      args.device.applyVolumeLimitSettings();
    });
    action('set_volume_limit_value', async (args) => {
      await args.device.setSettings({ volume_limit_max: args.volume });
      args.device.applyVolumeLimitSettings();
    });

    // --- Volume step helpers ---
    action('volume_up_by',   async (args) => args.device.volumeUpBy(args.steps));
    action('volume_down_by', async (args) => args.device.volumeDownBy(args.steps));

    // --- Enum / set actions ---
    enumAction('set_input',             'bravia_input',             'input');
    enumAction('set_drc',               'bravia_drc');
    enumAction('set_hdmi_passthrough',  'bravia_hdmi_passthrough');
    enumAction('set_bluetooth_mode',    'bravia_bluetooth_mode');
    action('set_rear_level', async (args) => setCap(args.device, 'bravia_rear_level', args.level));
    action('set_bass_level', async (args) => {
      if (args.device.hasCapability('bravia_bass_level')) {
        return setCap(args.device, 'bravia_bass_level', args.level);
      }
      if (args.device.hasCapability('bravia_bass_select')) {
        return setCap(args.device, 'bravia_bass_select', String(args.level));
      }
      return undefined;
    });

    // --- Boolean turn on/off actions ---
    boolAction('turn_voice_enhancer_on',  'bravia_voice_enhancer', true);
    boolAction('turn_voice_enhancer_off', 'bravia_voice_enhancer', false);
    boolAction('turn_sound_field_on',     'bravia_sound_field',    true);
    boolAction('turn_sound_field_off',    'bravia_sound_field',    false);
    boolAction('turn_night_mode_on',      'bravia_night_mode',     true);
    boolAction('turn_night_mode_off',     'bravia_night_mode',     false);
    boolAction('turn_hdmi_cec_on',        'bravia_hdmi_cec',       true);
    boolAction('turn_hdmi_cec_off',       'bravia_hdmi_cec',       false);
    boolAction('turn_auto_standby_on',    'bravia_auto_standby',   true);
    boolAction('turn_auto_standby_off',   'bravia_auto_standby',   false);
    boolAction('turn_aav_on',             'bravia_aav',            true);
    boolAction('turn_aav_off',            'bravia_aav',            false);

    // --- Conditions ---
    enumCondition('input_is',             'bravia_input', 'input');
    enumCondition('drc_is',               'bravia_drc');
    enumCondition('hdmi_passthrough_is',  'bravia_hdmi_passthrough');
    enumCondition('bluetooth_mode_is',    'bravia_bluetooth_mode');
    boolCondition('power_is_on',          'onoff');
    boolCondition('is_muted',             'volume_mute');
    boolCondition('night_mode_is_on',     'bravia_night_mode');
    boolCondition('voice_enhancer_is_on', 'bravia_voice_enhancer');
    boolCondition('sound_field_is_on',    'bravia_sound_field');
    boolCondition('hdmi_cec_is_on',       'bravia_hdmi_cec');
    boolCondition('auto_standby_is_on',   'bravia_auto_standby');
    boolCondition('aav_is_on',            'bravia_aav');
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
