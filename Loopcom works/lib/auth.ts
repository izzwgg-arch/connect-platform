import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { prisma } from './prisma'
import { User } from '@prisma/client'
import { createHash } from 'crypto'

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production'
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'your-refresh-secret-change-in-production'
const JWT_EXPIRES_IN = '15m'
const JWT_REFRESH_EXPIRES_IN = '30d'

export interface JWTPayload {
  userId: string
  tenantId: string
  email: string
  role: string
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export function generateAccessToken(payload: JWTPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
}

export function generateRefreshToken(payload: JWTPayload): string {
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: JWT_REFRESH_EXPIRES_IN })
}

export function verifyAccessToken(token: string): JWTPayload {
  return jwt.verify(token, JWT_SECRET) as JWTPayload
}

export function verifyRefreshToken(token: string): JWTPayload {
  return jwt.verify(token, JWT_REFRESH_SECRET) as JWTPayload
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createRefreshToken(userId: string, token: string, deviceId: string): Promise<void> {
  const tokenHash = hashRefreshToken(token)
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + 30)

  // Keep one active refresh session per user-device pair.
  await prisma.refreshToken.updateMany({
    where: {
      userId,
      deviceId,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  })

  await prisma.refreshToken.create({
    data: {
      userId,
      deviceId,
      token,
      tokenHash,
      expiresAt,
    },
  })
}

export async function getRefreshTokenRecord(token: string) {
  const tokenHash = hashRefreshToken(token)
  return prisma.refreshToken.findFirst({
    where: {
      OR: [{ tokenHash }, { tokenHash: token }],
    },
    include: {
      user: true,
    },
  })
}

export async function deleteRefreshToken(token: string): Promise<void> {
  const tokenHash = hashRefreshToken(token)
  await prisma.refreshToken.updateMany({
    where: {
      OR: [{ tokenHash }, { tokenHash: token }],
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  })
}

export async function getUserFromToken(token: string): Promise<User | null> {
  try {
    const payload = verifyAccessToken(token)
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { tenant: true },
    })
    return user
  } catch {
    return null
  }
}

export function generateTemporaryPassword(): string {
  // Generate secure random password
  const length = 12
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*'
  let password = ''
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length))
  }
  return password
}

export function generatePasswordResetToken(expiresIn: string | number = '1h'): string {
  return jwt.sign({ type: 'password-reset', timestamp: Date.now() }, JWT_SECRET, { expiresIn })
}
