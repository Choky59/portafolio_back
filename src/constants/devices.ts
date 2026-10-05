export const DEVICE_TYPES = ["ESP32", "ESP32-S3", "ESP32-C3", "ESP8266"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

export const DEVICE_STATUSES = ["PENDING", "ACTIVE", "REVOKED"] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/** How long a claim (pairing) code stays valid */
export const CLAIM_CODE_TTL_MS = 10 * 60 * 1000;

/** Minimum time between lastSeenAt writes for the same device */
export const LAST_SEEN_THROTTLE_MS = 60 * 1000;
