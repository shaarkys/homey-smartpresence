"use strict";

const net = require("net");

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;

function normalizeHost(host) {
  return typeof host === "string" ? host.trim() : "";
}

function isValidHost(host) {
  const normalizedHost = normalizeHost(host);
  return !!normalizedHost && (net.isIP(normalizedHost) !== 0 || HOSTNAME_PATTERN.test(normalizedHost));
}

module.exports = {
  isValidHost,
  normalizeHost,
};
