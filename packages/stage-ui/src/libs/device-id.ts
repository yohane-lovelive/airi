/** The `localStorage` key of the device id. The settings sync does not list it, so it never leaves the device. */
export const DEVICE_ID_KEY = 'airi/device-id'

/**
 * A random id of this app on this device. Every window of the app reads the same one. It says nothing about the device,
 * so the server can tell the devices of an account apart without knowing them.
 *
 * Use when:
 * - The device floor asks the server which device runs autonomous speech.
 */
export function deviceId(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage) {
  const stored = storage.getItem(DEVICE_ID_KEY)
  if (stored)
    return stored
  const id = crypto.randomUUID()
  storage.setItem(DEVICE_ID_KEY, id)
  return id
}
