import { HashRouter, Routes, Route, NavLink } from 'react-router-dom';
import { LibraryPage } from './pages/LibraryPage';
import { SetupPage } from './pages/SetupPage';
import { PracticePage } from './pages/PracticePage';
import { ReportPage } from './pages/ReportPage';

export function App() {
  return (
    <HashRouter>
      <div className="app">
        <nav className="topnav">
          <NavLink to="/" className="brand">
            TradeLab
          </NavLink>
          <div className="navlinks">
            <NavLink to="/" end>
              练习
            </NavLink>
            <NavLink to="/setup">新建</NavLink>
          </div>
        </nav>
        <main className="content">
          <Routes>
            <Route path="/" element={<LibraryPage />} />
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/practice/:sessionId" element={<PracticePage />} />
            <Route path="/report/:sessionId" element={<ReportPage />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
