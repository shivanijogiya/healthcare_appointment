import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './index.css';
import { AuthProvider, homeFor, useAuth } from './lib/auth';
import Shell from './components/Shell';
import SignIn from './portals/SignIn';
import PatientPortal from './portals/PatientPortal';
import DoctorPortal from './portals/DoctorPortal';
import AdminPortal from './portals/AdminPortal';
import { Spinner } from './components/ui';

/** Route guard: the API enforces access; this only avoids showing a dead page. */
function Guard({ role, children }: { role: 'PATIENT' | 'DOCTOR' | 'ADMIN'; children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="mx-auto max-w-md px-4"><Spinner label="Restoring your session" /></div>;
  if (!user) return <Navigate to="/" replace />;
  if (user.role !== role) return <Navigate to={homeFor(user)} replace />;
  return <>{children}</>;
}

function Landing() {
  const { user, loading } = useAuth();
  if (loading) return <div className="mx-auto max-w-md px-4"><Spinner /></div>;
  return user ? <Navigate to={homeFor(user)} replace /> : <SignIn />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Shell>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/patient" element={<Guard role="PATIENT"><PatientPortal /></Guard>} />
            <Route path="/doctor" element={<Guard role="DOCTOR"><DoctorPortal /></Guard>} />
            <Route path="/admin" element={<Guard role="ADMIN"><AdminPortal /></Guard>} />
            <Route path="/calendar" element={<Landing />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
