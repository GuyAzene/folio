/**
 * What a question records when the student starts it with `/`: one of their routines, or a
 * prompt one of their services offers. Saved on their message, so the chat shows it as it was.
 */
export type CommandRecord =
  | {
      v: 1;
      kind: "skill";
      name: string;
      /** Where the skill came from when it was started: "Folio", or a folder the student added. */
      from: string;
      digest: string;
    }
  | {
      v: 1;
      kind: "prompt";
      server: string;
      /** The service's name as the student calls it, such as "Moodle". */
      label: string;
      name: string;
      args: Record<string, string>;
      digest: string;
    };
