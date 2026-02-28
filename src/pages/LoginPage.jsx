import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import toast from 'react-hot-toast'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const { signIn } = useAuth()
  const navigate = useNavigate()

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    const { error } = await signIn(email, password)
    if (error) {
      toast.error(error.message)
    } else {
      navigate('/dashboard')
    }
    setLoading(false)
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0d0d14',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: "'DM Sans', sans-serif",
      padding: '1rem'
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500&family=DM+Sans:wght@300;400;500&display=swap');
        .login-input {
          width: 100%;
          background: #1a1a2c;
          border: 1px solid rgba(200,169,110,0.2);
          border-radius: 10px;
          color: #e8dcc8;
          padding: 0.7rem 1rem;
          font-size: 0.9rem;
          font-family: 'DM Sans', sans-serif;
          transition: border-color 0.15s;
          outline: none;
        }
        .login-input:focus { border-color: #c8a96e; }
        .login-input::placeholder { color: #5a5060; }
        .login-btn {
          width: 100%;
          padding: 0.75rem;
          background: #c8a96e;
          color: #0d0d14;
          border: none;
          border-radius: 10px;
          font-family: 'DM Sans', sans-serif;
          font-size: 0.9rem;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.15s;
          letter-spacing: 0.05em;
        }
        .login-btn:hover { background: #e2c48a; }
        .login-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      `}</style>

      <div style={{ width: '100%', maxWidth: '360px' }}>
        <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
          <div style={{
            width: '56px', height: '56px',
            background: 'rgba(200,169,110,0.1)',
            border: '1px solid rgba(200,169,110,0.3)',
            borderRadius: '16px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '1.75rem', margin: '0 auto 1rem'
          }}>🏠</div>
          <div style={{
            fontFamily: "'Cormorant Garamond', serif",
            fontSize: '2rem', color: '#c8a96e', letterSpacing: '0.05em'
          }}>Casa</div>
          <div style={{ color: '#5a5060', fontSize: '0.75rem', letterSpacing: '0.15em', textTransform: 'uppercase' }}>
            House Tracker
          </div>
        </div>

        <div style={{
          background: '#141420',
          border: '1px solid rgba(200,169,110,0.15)',
          borderRadius: '16px',
          padding: '2rem'
        }}>
          <h2 style={{
            fontFamily: "'Cormorant Garamond', serif",
            fontSize: '1.4rem', fontWeight: 400,
            color: '#e8dcc8', marginBottom: '1.5rem'
          }}>Sign in</h2>

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <div style={{ fontSize: '0.72rem', color: '#8a8090', letterSpacing: '0.05em', marginBottom: '0.4rem' }}>EMAIL</div>
              <input
                className="login-input"
                type="email"
                placeholder="you@email.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <div style={{ fontSize: '0.72rem', color: '#8a8090', letterSpacing: '0.05em', marginBottom: '0.4rem' }}>PASSWORD</div>
              <input
                className="login-input"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </div>
            <button className="login-btn" type="submit" disabled={loading} style={{ marginTop: '0.5rem' }}>
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p style={{ textAlign: 'center', color: '#3a3040', fontSize: '0.72rem', marginTop: '1.5rem' }}>
          Accounts are created by your administrator
        </p>
      </div>
    </div>
  )
}
