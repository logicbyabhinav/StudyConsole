const EventEmitter = require("events");

const dashboardEvents = new EventEmitter();
dashboardEvents.setMaxListeners(100);

function notifyDashboardChanged() {
  dashboardEvents.emit("changed");
}

module.exports = { dashboardEvents, notifyDashboardChanged };
