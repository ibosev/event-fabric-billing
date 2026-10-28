import { page } from "../lib/module.ts";
import { Card, Empty, PageHeader, button, small } from "../lib/ui.tsx";

export const notFound = page(() => () => (
  <>
    <PageHeader title="Page not found" />
    <Card>
      <Empty icon="search" title="Nothing lives here">
        <a href="#/" class={`${button}${small} mt-3`}>Back to the dashboard</a>
      </Empty>
    </Card>
  </>
));
