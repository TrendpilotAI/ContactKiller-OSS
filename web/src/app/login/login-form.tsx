'use client'

import { useState } from 'react'

interface LoginFormProps {
  next: string
  signedIn: boolean
  signupEnabled: boolean
}

export function LoginForm({ next, signedIn, signupEnabled }: LoginFormProps) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (response.ok) {
        window.location.assign(next)
        return
      }
      const data = await response.json().catch(() => ({}))
      setError(data.error || 'Something went wrong.')
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    await fetch('/api/auth/signout', { method: 'POST' })
    window.location.assign('/login')
  }

  if (signedIn) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <p className="text-gray-700 mb-4">You are signed in.</p>
        <div className="flex gap-3">
          <a
            href={next}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition"
          >
            Continue
          </a>
          <button
            type="button"
            onClick={signOut}
            className="bg-gray-200 text-gray-800 px-4 py-2 rounded-lg font-medium hover:bg-gray-300 transition"
          >
            Sign out
          </button>
        </div>
      </div>
    )
  }

  return (
    <form
      onSubmit={submit}
      className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 space-y-4"
    >
      <h2 className="text-lg font-semibold text-gray-900">
        {mode === 'signin' ? 'Sign in' : 'Create account'}
      </h2>
      <label className="block text-sm font-medium text-gray-700">
        Email
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg"
        />
      </label>
      <label className="block text-sm font-medium text-gray-700">
        Password
        <input
          type="password"
          required
          minLength={mode === 'signup' ? 12 : undefined}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg"
        />
        {mode === 'signup' && (
          <span className="block mt-1 text-xs text-gray-500">At least 12 characters.</span>
        )}
      </label>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="w-full bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50"
      >
        {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
      </button>
      {signupEnabled && (
        <button
          type="button"
          onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin')
            setError(null)
          }}
          className="w-full text-sm text-blue-600 hover:text-blue-700"
        >
          {mode === 'signin' ? 'Need an account? Create one' : 'Have an account? Sign in'}
        </button>
      )}
    </form>
  )
}
