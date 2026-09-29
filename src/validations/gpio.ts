/**
 * GPIO rules for the classic ESP32 DevKit (ESP32-WROOM-32, 30/38-pin boards).
 *
 * ESP32-S3 / C3 / S2 boards have different pins. If you move to one of those,
 * change the three sets below and nothing else.
 */

// Pins that can be used as input AND output.
const OUTPUT_CAPABLE = new Set([
  0, 2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33,
])

// Input-only pins (no output driver, no internal pull-up/down).
const INPUT_ONLY = new Set([34, 35, 36, 39])

// ADC1 pins. ADC2 pins cannot be read with analogRead() while WiFi is on.
const ADC1 = new Set([32, 33, 34, 35, 36, 39])

// Same idea as the firmware: these sensor types are read with analogRead().
const ANALOG_TYPE = /ldr|light|analog|adc/i

export type GpioRole = 'sensor' | 'actuator'

export type GpioIssue = { message: string; path: (string | number)[] }

export type GpioFields = {
  type?: string
  interface?: string
  gpio?: number
  pins?: Record<string, number>
}

function unavailableReason(gpio: number): string {
  if (gpio === 1 || gpio === 3) {
    return `GPIO ${gpio} is UART0 (Serial/USB) and is used for flashing and logging`
  }
  if (gpio >= 6 && gpio <= 11) {
    return `GPIO ${gpio} is connected to the internal flash and cannot be used`
  }
  return `GPIO ${gpio} is not available on an ESP32 DevKit board`
}

/** Returns a human-readable problem, or null when the pin is fine. */
export function gpioProblem(
  gpio: number,
  role: GpioRole,
  analog = false,
): string | null {
  if (!Number.isInteger(gpio)) return 'GPIO must be a whole number'

  const usable =
    role === 'actuator'
      ? OUTPUT_CAPABLE.has(gpio)
      : OUTPUT_CAPABLE.has(gpio) || INPUT_ONLY.has(gpio)

  if (!usable) {
    if (role === 'actuator' && INPUT_ONLY.has(gpio)) {
      return `GPIO ${gpio} is input-only and cannot drive an actuator`
    }
    return unavailableReason(gpio)
  }

  if (analog && !ADC1.has(gpio)) {
    return `GPIO ${gpio} is on ADC2, which does not work while WiFi is on. Use an ADC1 pin: 32, 33, 34, 35, 36 or 39`
  }

  return null
}

/** Checks gpio and pins of a sensor/actuator payload. Works for partial updates too. */
export function collectGpioIssues(
  role: GpioRole,
  data: GpioFields,
): GpioIssue[] {
  const issues: GpioIssue[] = []

  const analog =
    role === 'sensor' &&
    (ANALOG_TYPE.test(String(data.type ?? '')) ||
      String(data.interface ?? '').toLowerCase() === 'analog')

  if (data.gpio !== undefined) {
    const problem = gpioProblem(data.gpio, role, analog)
    if (problem) issues.push({ message: problem, path: ['gpio'] })
  }

  if (data.pins) {
    for (const [label, pin] of Object.entries(data.pins)) {
      const problem = gpioProblem(pin, role)
      if (problem) issues.push({ message: `pins.${label}: ${problem}`, path: ['pins', label] })
    }
  }

  return issues
}