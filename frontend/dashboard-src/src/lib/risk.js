export function isAtRisk(d) {
  return (
    (d.storage_free_mb !== null && d.storage_free_mb !== undefined && d.storage_free_mb < 500) ||
    (d.ram_total_mb > 0 && d.ram_free_mb / d.ram_total_mb < 0.1)
  );
}

export function isWeakSignal(d) {
  return d.wifi_rssi !== null && d.wifi_rssi !== undefined && d.wifi_rssi < -75;
}
