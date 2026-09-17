import { Schema, model } from 'mongoose'
const sensorSchema = new Schema({ deviceId: { type: Schema.Types.ObjectId, ref: 'Device', required: true, index: true }, name: { type: String, required: true, trim: true }, type: { type: String, required: true, trim: true }, gpio: { type: Number, min: 0, max: 39 }, value: Schema.Types.Mixed, unit: String, status: { type: String, enum: ['normal','warning','error'], default: 'normal' }, lastUpdated: Date }, { timestamps: true })
export const Sensor = model('Sensor', sensorSchema)
