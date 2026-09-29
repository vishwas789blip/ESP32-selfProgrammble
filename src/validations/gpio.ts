const OUTPUT_OK = new Set([0,2,4,5,12,13,14,15,16,17,18,19,21,22,23,25,26,27,32,33])
const INPUT_ONLY = new Set([34,35,36,39])
const ADC1 = new Set([32,33,34,35,36,39]) // ADC2 WiFi ke saath analogRead nahi karta

const bad = (message: string) =>
  Object.assign(new Error(message), { statusCode: 400, code: 'INVALID_GPIO' })

export function assertValidGpio(
  gpio: unknown,
  role: 'sensor' | 'actuator',
  analog = false,
) {
  if (gpio === undefined || gpio === null) return
  const n = Number(gpio)
  if (!Number.isInteger(n)) throw bad('GPIO must be an integer')
  const allowed = role === 'actuator' ? OUTPUT_OK : new Set([...OUTPUT_OK, ...INPUT_ONLY])
  if (!allowed.has(n)) throw bad(`GPIO ${n} is not valid for a ${role} on ESP32`)
  if (analog && !ADC1.has(n)) throw bad(`GPIO ${n} is ADC2; use ADC1 pin (32-39) while WiFi is on`)
}