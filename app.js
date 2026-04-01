'use strict';

const Homey = require('homey');

module.exports = class BraviaTheaterQuadApp extends Homey.App {
  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Sony Bravia Theater Quad app has been initialized');
  }
};
