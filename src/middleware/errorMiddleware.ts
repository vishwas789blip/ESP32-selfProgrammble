import { ErrorRequestHandler } from 'express'
import mongoose from 'mongoose'
import { ZodError } from 'zod'

export const errorMiddleware: ErrorRequestHandler = (
  error,
  _req,
  res,
  _next
) => {
  // Zod validation error
  if (error instanceof ZodError) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        details: error.issues,
      },
    })
  }

  // Invalid MongoDB ObjectId
  if (error instanceof mongoose.Error.CastError) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_ID',
        message: 'Invalid ObjectId',
      },
    })
  }

  // MongoDB duplicate key error
  if (error?.code === 11000) {
    const duplicateFields = error.keyValue
      ? Object.keys(error.keyValue)
      : []

    const field = duplicateFields[0] || 'field'
    const value = error.keyValue?.[field]

    return res.status(409).json({
      success: false,
      error: {
        code: 'DUPLICATE_KEY',
        message: value
          ? `${field} '${value}' already exists`
          : 'A record with this value already exists',
      },
    })
  }

  // Other errors
  const status = Number(error.statusCode) || 500

  if (status >= 500) {
    console.error(error)
  }

  return res.status(status).json({
    success: false,
    error: {
      code: error.code ?? 'INTERNAL_ERROR',
      message:
        status >= 500
          ? 'Internal server error'
          : error.message,
    },
  })
}