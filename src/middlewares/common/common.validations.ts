// middlewares/common/common.validations.ts
import { findUser, findUserSession } from './common.services'
import { NextFunction, Request, Response } from 'express'
import { sendErrorResponse } from '../../constants/errorResponse'
import { ValidationChain, validationResult } from 'express-validator'

export function createValidation(validators: ValidationChain[]) {
  return [
    ...validators,
    (req: Request, res: Response, next: NextFunction) => {
      const errors = validationResult(req)
      if (!errors.isEmpty()) {
        sendErrorResponse(res, 400, { data: errors.array().map((e) => e.msg) })
        return
      }
      next()
    },
  ]
}

/**
 * Header: session: <token>
 *
 * On success:
 * - req.body.session -> ISession
 * - res.locals.user  -> IProfile (ACTIVE)
 */
export async function sessionValidation(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const header = req.headers.session
  const token = typeof header === 'string' ? header.trim() : ''

  if (!token) {
    return sendErrorResponse(res, 401, {
      key: 'UNAUTHORIZED',
      message: 'Missing session token (header "session")',
    })
  }

  const session = await findUserSession(token)
  if (!session.data) {
    return sendErrorResponse(res, 401, {
      key: 'UNAUTHORIZED',
      message: 'Missing or invalid session',
    })
  }

  const user = await findUser(session.data.userId)
  if (!user.data || user.data.status !== 'ACTIVE') {
    return sendErrorResponse(res, 401, {
      key: 'UNAUTHORIZED',
      message: 'Session user not found or not authorized',
    })
  }

  // Ensure req.body exists (important for GETs with no body)
  ;(req as any).body = (req as any).body ?? {}
  ;(req as any).body.session = session.data
  res.locals.user = user.data

  next()
}

/** Must run after sessionValidation */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = res.locals.user

  if (!user?._id) {
    return sendErrorResponse(res, 401, {
      key: 'UNAUTHORIZED',
      message: 'Missing or invalid session',
    })
  }

  if (user.role !== 'ADMIN') {
    return sendErrorResponse(res, 403, {
      key: 'FORBIDDEN',
      message: 'You do not have permission to perform this action',
      role: user.role,
    })
  }

  next()
}
