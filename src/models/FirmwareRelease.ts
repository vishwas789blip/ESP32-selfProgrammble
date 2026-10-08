import { Schema, model, type Document } from 'mongoose'

export interface IFirmwareRelease extends Document {
  version: string
  title: string
  description?: string
  changelog: string[]
  releaseDate: Date
  fileSize?: string
  minHardwareVersion?: string
  downloadUrl?: string
  checksum?: string
  status: 'installed' | 'available' | 'deprecated'
  isLatest: boolean
  createdAt: Date
  updatedAt: Date
}

const firmwareReleaseSchema = new Schema<IFirmwareRelease>(
  {
    version: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    changelog: {
      type: [String],
      default: [],
    },
    releaseDate: {
      type: Date,
      default: Date.now,
    },
    fileSize: {
      type: String,
      default: '1.24 MB',
    },
    minHardwareVersion: {
      type: String,
      default: 'ESP32-WROOM-32',
    },
    downloadUrl: {
      type: String,
    },
    checksum: {
      type: String,
    },
    status: {
      type: String,
      enum: ['installed', 'available', 'deprecated'],
      default: 'available',
    },
    isLatest: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
)

export const FirmwareRelease = model<IFirmwareRelease>(
  'FirmwareRelease',
  firmwareReleaseSchema,
)
