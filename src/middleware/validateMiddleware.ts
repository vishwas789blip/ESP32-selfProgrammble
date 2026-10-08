import { RequestHandler } from 'express'
import { ZodType } from 'zod'

export const validate = (schema: ZodType): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req.body)

    if (!result.success) {
      next(result.error)
      return
    }

    req.body = result.data
    next()
  }
