import { Compass } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';

export function NotFound() {
  return (
    <div className="py-16">
      <EmptyState icon={<Compass className="h-5 w-5" />} title="Page not found" body="That page doesn't exist or you don't have access to it." action={<Link to="/"><Button variant="primary">Back to dashboard</Button></Link>} />
    </div>
  );
}
