import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { Home, Building2, Banknote, LogOut } from 'lucide-react'
import './Layout.css'

export default function Layout() {
  const { profile, signOut } = useAuth()
  const navigate = useNavigate()

  const handleSignOut = async () => {
    await signOut()
    navigate('/login')
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-icon">🏠</div>
          <div>
            <div className="brand-name">Casa</div>
            <div className="brand-sub">House Tracker</div>
          </div>
        </div>

        <nav className="sidebar-nav">
          <NavLink to="/dashboard" className={({isActive}) => isActive ? 'nav-item active' : 'nav-item'}>
            <Home size={18} /> Dashboard
          </NavLink>
          <NavLink to="/mortgage" className={({isActive}) => isActive ? 'nav-item active' : 'nav-item'}>
            <Banknote size={18} /> Mortgage
          </NavLink>
          <NavLink to="/projects" className={({isActive}) => isActive ? 'nav-item active' : 'nav-item'}>
            <Building2 size={18} /> Projects
          </NavLink>
        </nav>

        <div className="sidebar-footer">
          <div className="user-pill">
            <div className="user-avatar">{profile?.full_name?.[0] || '?'}</div>
            <span>{profile?.full_name || 'User'}</span>
          </div>
          <button className="signout-btn" onClick={handleSignOut} title="Sign out">
            <LogOut size={16} />
          </button>
        </div>
      </aside>

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  )
}
