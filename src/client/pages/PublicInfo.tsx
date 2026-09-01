import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { SelvedgeLockup } from '../components/Logo.js';

type Section = { title: string; body: string };

const privacy: Section[] = [
  { title: 'What we keep', body: 'Account details, project content, imported history, service configuration, and the operational logs needed to run Selvedge.' },
  { title: 'Why we keep it', body: 'To provide the product, secure accounts, operate workspaces, support projects, and improve reliability.' },
  { title: 'Who processes it', body: 'The infrastructure, authentication, model, and workspace providers required to deliver the service. Selvedge does not sell personal data.' },
  { title: 'Your control', body: 'Your projects and production accounts remain yours. You can export project records and request deletion of your account data.' },
  { title: 'Secrets', body: 'Credentials are scoped to the work that needs them. Selvedge does not place secret values in your repository.' },
];

const terms: Section[] = [
  { title: 'Your account', body: 'Keep access secure and use accurate information. You are responsible for activity performed through your account.' },
  { title: 'Your work', body: 'You retain ownership of project content. You give Selvedge permission to process it only as needed to provide the service.' },
  { title: 'AI and third parties', body: 'Agents and connected services can make mistakes or change their terms. Review important work before approving a production change.' },
  { title: 'Acceptable use', body: 'Do not use Selvedge to break the law, harm others, defeat security controls, or access systems without permission.' },
  { title: 'Service changes', body: 'Features and limits may change. We will give reasonable notice when a material change affects paid use.' },
  { title: 'Availability', body: 'Selvedge is provided as available. Keep appropriate backups and recovery plans for production systems.' },
];

function PublicShell({ title, intro, children }: { title: string; intro: string; children: React.ReactNode }) {
  return <div className="public-info">
    <header><div><Link to="/"><SelvedgeLockup tone="chalk" className="h-7 w-auto" /></Link><Link to="/request-invite">Request an invite</Link></div></header>
    <main><p className="public-info-label">Selvedge</p><h1>{title}</h1><p className="public-info-intro">{intro}</p>{children}<p className="public-info-updated">Updated August 31, 2026</p></main>
    <footer><Link to="/">Home</Link><Link to="/security">Security</Link><Link to="/privacy">Privacy</Link><Link to="/terms">Terms</Link><Link to="/status">Status</Link></footer>
  </div>;
}

function Sections({ items }: { items: Section[] }) {
  return <div className="public-info-sections">{items.map((item) => <section key={item.title}><h2>{item.title}</h2><p>{item.body}</p></section>)}</div>;
}

export function Privacy() {
  return <PublicShell title="Privacy" intro="Plain language about the data Selvedge needs."><Sections items={privacy} /></PublicShell>;
}

export function Terms() {
  return <PublicShell title="Terms" intro="The basic rules for using Selvedge."><Sections items={terms} /></PublicShell>;
}

export function Status() {
  const [state, setState] = useState<'checking' | 'up' | 'down'>('checking');
  const [checkedAt, setCheckedAt] = useState('');

  useEffect(() => {
    fetch('/healthz', { cache: 'no-store' })
      .then((response) => { if (!response.ok) throw new Error('health check failed'); return response.json(); })
      .then(() => setState('up'))
      .catch(() => setState('down'))
      .finally(() => setCheckedAt(new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
  }, []);

  const copy = state === 'checking' ? 'Checking Selvedge…' : state === 'up' ? 'All systems operational.' : 'Selvedge is experiencing an interruption.';
  return <PublicShell title="Status" intro="A live check of the Selvedge service."><div className={`public-status public-status-${state}`}><span aria-hidden="true" /><div><h2>{copy}</h2>{checkedAt && <p>Checked at {checkedAt}.</p>}</div></div><p className="public-status-note">Customer hosting and connected AI providers operate independently.</p></PublicShell>;
}
