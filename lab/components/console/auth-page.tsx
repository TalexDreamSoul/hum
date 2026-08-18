"use client";

import type { ReactNode } from "react";
import { Grid, GridItem, LayerCard, Text } from "@cloudflare/kumo";

export function AuthPage({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main>
      <Grid variant="3up" gap="base">
        <GridItem />
        <GridItem>
          <LayerCard>
            <LayerCard.Secondary>
              <Grid gap="sm">
                <Text variant="heading1" as="h1">{title}</Text>
                <Text variant="secondary">{description}</Text>
              </Grid>
            </LayerCard.Secondary>
            <LayerCard.Primary>{children}</LayerCard.Primary>
          </LayerCard>
        </GridItem>
        <GridItem />
      </Grid>
    </main>
  );
}
