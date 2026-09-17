import bcrypt from 'bcryptjs'
import { User } from '../models/User.js'
import { generateToken } from '../utils/generateToken.js'

const publicUser = (user: { _id: unknown; name: string; email: string }) => ({ id: String(user._id), name: user.name, email: user.email })
export async function register(input: { name: string; email: string; password: string }) { const exists = await User.exists({ email: input.email }); if (exists) throw Object.assign(new Error('Email already registered'), { statusCode: 409, code: 'EMAIL_EXISTS' }); const user = await User.create({ name: input.name, email: input.email, passwordHash: await bcrypt.hash(input.password, 12) }); return { user: publicUser(user), token: generateToken(String(user._id)) } }
export async function login(input: { email: string; password: string }) { const user = await User.findOne({ email: input.email }).select('+passwordHash'); if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) throw Object.assign(new Error('Invalid email or password'), { statusCode: 401, code: 'INVALID_CREDENTIALS' }); return { user: publicUser(user), token: generateToken(String(user._id)) } }
export async function me(id: string) { const user = await User.findById(id); if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404, code: 'NOT_FOUND' }); return publicUser(user) }
