import type { DockerContainerRow } from "../scanner";
import { resolveServiceName } from "./serviceMapping";

export type VolumeMountRef = {
  volumeName: string;
  containerName: string;
  containerId: string;
  service: string;
  image: string;
  state: string;
  mountDestination: string;
  mountType: string;
};

export function buildVolumeMountIndex(containers: DockerContainerRow[]): Map<string, VolumeMountRef[]> {
  const index = new Map<string, VolumeMountRef[]>();
  for (const c of containers) {
    const name = (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, "");
    const service = resolveServiceName(name, c.Image);
    for (const m of c.Mounts ?? []) {
      if (m.Type !== "volume" || !m.Name) continue;
      const ref: VolumeMountRef = {
        volumeName: m.Name,
        containerName: name,
        containerId: c.Id.slice(0, 12),
        service,
        image: c.Image,
        state: c.State ?? "unknown",
        mountDestination: m.Destination ?? "",
        mountType: m.Type,
      };
      const list = index.get(m.Name) ?? [];
      list.push(ref);
      index.set(m.Name, list);
    }
  }
  return index;
}
