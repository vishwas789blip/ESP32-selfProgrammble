import { Schema, model, InferSchemaType } from 'mongoose'
const userSchema = new Schema({ name: { type: String, required: true, trim: true }, email: { type: String, required: true, unique: true, lowercase: true, trim: true }, passwordHash: { type: String, required: true, select: false } }, { timestamps: true })
export type UserDocument = InferSchemaType<typeof userSchema>
export const User = model('User', userSchema)
