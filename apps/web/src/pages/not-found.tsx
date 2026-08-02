import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";

export default function NotFound() {
  const [location] = useLocation();

  return (
    <div className="flex w-full mt-20 items-start justify-center">
      <Card className="w-full max-w-md border-border/50 bg-muted/20">
        <CardContent className="pt-6">
          <div className="flex mb-4 gap-2 text-destructive">
            <AlertCircle className="h-8 w-8" />
            <h1 className="text-2xl font-bold font-mono text-foreground">404_NOT_FOUND</h1>
          </div>

          <p className="mt-4 text-sm text-muted-foreground font-mono">
            Did not find route at: <span className="text-primary">{location}</span>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
