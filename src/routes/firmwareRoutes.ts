import { Router, type Response } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { authMiddleware } from '../middleware/authMiddleware.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import type { AuthRequest } from '../types/index.js'
import { getUserId, getParam } from '../controllers/common.js'
import * as firmwareService from '../services/firmwareService.js'

export const firmwareRoutes = Router()

// Configure multer storage for binary .bin uploads
const uploadDir = path.resolve(process.cwd(), 'uploads', 'firmware')
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir)
  },
  filename: (_req, file, cb) => {
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')
    cb(null, `${Date.now()}-${cleanName}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 16 * 1024 * 1024 }, // 16 MB max for ESP32 flash
  fileFilter: (_req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.bin') || file.mimetype === 'application/octet-stream') {
      cb(null, true)
    } else {
      cb(new Error('Only .bin firmware binary files are supported'))
    }
  },
})

// Public endpoint for ESP32 to download binary without JWT
firmwareRoutes.get(
  '/bin/:filename',
  asyncHandler(async (req, res) => {
    const filename = path.basename(getParam(req.params.filename))
    const filePath = path.resolve(uploadDir, filename)
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'Firmware binary file not found' })
    }
    const stat = await fs.promises.stat(filePath)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Content-Length', stat.size)
    const stream = fs.createReadStream(filePath)
    stream.pipe(res)
  }),
)

// Protected routes below
firmwareRoutes.use(authMiddleware)

// List all registered firmware releases
firmwareRoutes.get(
  '/',
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const releases = await firmwareService.listReleases()
    res.json({ success: true, data: releases })
  }),
)

// Get latest available firmware release
firmwareRoutes.get(
  '/latest',
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const latest = await firmwareService.getLatestRelease()
    res.json({ success: true, data: latest })
  }),
)

// Check update status for a specific device
firmwareRoutes.post(
  '/check/:deviceId',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = getUserId(req)
    const deviceId = getParam(req.params.deviceId)
    const result = await firmwareService.checkDeviceUpdate(userId, deviceId)
    res.json({ success: true, data: result })
  }),
)

// Deploy OTA firmware update to a device
firmwareRoutes.post(
  '/deploy',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = getUserId(req)
    const { deviceId, version } = req.body
    if (!deviceId || !version) {
      return res.status(400).json({
        success: false,
        message: 'deviceId and version are required to deploy firmware',
      })
    }
    const result = await firmwareService.deployOta(userId, String(deviceId), String(version))
    res.json({ success: true, data: result })
  }),
)

// Upload new .bin firmware binary
firmwareRoutes.post(
  '/upload',
  upload.single('file'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = getUserId(req)
    const file = req.file
    if (!file) {
      return res.status(400).json({ success: false, message: 'Please select a .bin firmware binary file' })
    }
    const { version, title, description, changelog, deviceId, autoDeploy } = req.body
    if (!version || !title) {
      return res.status(400).json({ success: false, message: 'Version and title are required' })
    }

    let parsedChangelog: string[] = []
    if (typeof changelog === 'string') {
      try {
        parsedChangelog = JSON.parse(changelog)
      } catch {
        parsedChangelog = changelog.split('\n').map((s) => s.trim()).filter(Boolean)
      }
    } else if (Array.isArray(changelog)) {
      parsedChangelog = changelog
    }

    const result = await firmwareService.createReleaseFromUpload(
      userId,
      {
        version,
        title,
        description,
        changelog: parsedChangelog,
        file,
        deviceId: deviceId ? String(deviceId) : undefined,
        autoDeploy: autoDeploy === 'true' || autoDeploy === true,
      },
      req.headers.host,
    )

    res.json({ success: true, data: result })
  }),
)
