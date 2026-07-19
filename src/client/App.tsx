import { Routes, Route } from 'react-router-dom';
import { SignedIn, SignedOut, SignIn } from '@clerk/clerk-react';
import { Nav } from './components/Nav.js';
import { Today } from './pages/Today.js';
import { Projects } from './pages/Projects.js';
import { Tray } from './pages/Tray.js';
import { PackEditor } from './pages/PackEditor.js';

export default function App() {
  return (
    <>
      <SignedOut>
        <div className="flex min-h-screen items-center justify-center bg-slate-50">
          <SignIn />
        </div>
      </SignedOut>
      <SignedIn>
        <div className="min-h-screen bg-slate-50">
          <Nav />
          <main className="mx-auto max-w-3xl px-4 py-8">
            <Routes>
              <Route path="/" element={<Today />} />
              <Route path="/projects" element={<Projects />} />
              <Route path="/projects/:projectId/edit" element={<PackEditor />} />
              <Route path="/tray" element={<Tray />} />
            </Routes>
          </main>
        </div>
      </SignedIn>
    </>
  );
}
