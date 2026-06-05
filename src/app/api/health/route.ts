import { getHealth } from '@/lib/health';

export function GET() {
  return Response.json(getHealth());
}
