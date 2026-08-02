import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { ThemeProvider } from "@/components/theme-provider"
import { Shell } from "@/components/layout/Shell"

import Dashboard from "@/pages/Dashboard"
import Collection from "@/pages/Collection"
import Enrichment from "@/pages/Enrichment"
import Lookup from "@/pages/Lookup"
import Scheduler from "@/pages/Scheduler"
import Jobs from "@/pages/Jobs"
import Backups from "@/pages/Backups"
import Settings from "@/pages/Settings"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Shell>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/collection" component={Collection} />
        <Route path="/enrichment" component={Enrichment} />
        <Route path="/lookup" component={Lookup} />
        <Route path="/jobs" component={Jobs} />
        <Route path="/backups" component={Backups} />
        <Route path="/schedule" component={Scheduler} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </Shell>
  );
}

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
