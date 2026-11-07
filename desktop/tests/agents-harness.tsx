import React from 'react';
import { createRoot } from 'react-dom/client';
import { AgentsPanel } from '../src/AgentsPanel';
import '../src/styles.css';
import '../src/cyberpunk.css';
import { createFixture } from './agents-fixture.mjs';
if (!window.pi) window.pi = createFixture() as any;
createRoot(document.getElementById('root')!).render(<AgentsPanel models={[]} ready={true} cwd="/fixture/work" mainBusy={false} onClose={() => {}} onOpenParent={() => {}} onReference={text => { (window as any).__lastReference = text; }} />);
