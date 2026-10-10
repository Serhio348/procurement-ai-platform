import { useEffect, useRef, useState, type ReactElement } from "react";
import { errorText } from "../api/http.js";
import { fetchProcurementExport } from "../api/specialist.js";
import {
  acquireExportDirectory,
  downloadExportFile,
  loadExportDirectory,
  pickerWasCancelled,
  pickExportDirectory,
  saveExportDirectory,
  writeExportFolder,
  type RememberedDirectory,
} from "./export-folder.js";

export function ExportToFolderButton({ procurementId }: { procurementId: string }): ReactElement {
  const remembered = useRef<RememberedDirectory | undefined>(undefined);
  const [place, setPlace] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadExportDirectory()
      .then((handle) => {
        if (cancelled || handle === undefined) return;
        remembered.current = handle;
        setPlace(handle.name);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function onExport(): Promise<void> {
    setBusy(true);
    setFailed(false);
    setNote(undefined);
    try {
      const parent = await acquireExportDirectory(remembered.current);
      remembered.current = parent;
      setPlace(parent.name);
      const plan = await fetchProcurementExport(procurementId);
      const folderName = await writeExportFolder(parent, plan, (hash) => downloadExportFile(hash), (done, total) => {
        setProgress({ done, total });
      });
      const files = plan.files.length;
      setNote(
        files === 0
          ? `Сохранено в «${parent.name}/${folderName}». Скачанных файлов нет, в папке только карточка.`
          : `Сохранено в «${parent.name}/${folderName}». Файлов: ${String(files)}.`,
      );
    } catch (error) {
      if (pickerWasCancelled(error)) return;
      setFailed(true);
      setNote(errorText(error, "Не удалось выгрузить карточку"));
    } finally {
      setBusy(false);
      setProgress(undefined);
    }
  }

  async function onChangePlace(): Promise<void> {
    setFailed(false);
    try {
      const picked = await pickExportDirectory();
      await saveExportDirectory(picked);
      remembered.current = picked;
      setPlace(picked.name);
      setNote(`Дальше карточки сохраняются в «${picked.name}».`);
    } catch (error) {
      if (pickerWasCancelled(error)) return;
      setFailed(true);
      setNote(errorText(error, "Не удалось выбрать папку"));
    }
  }

  const label =
    busy && progress !== undefined && progress.total > 0
      ? `Выгружаем ${String(progress.done)} из ${String(progress.total)}…`
      : busy
        ? "Выгружаем…"
        : "Выгрузить в папку";

  return (
    <div className="export-folder">
      <button type="button" className="export-folder-button" disabled={busy} onClick={() => void onExport()}>
        {label}
      </button>
      {place === undefined ? null : (
        <button type="button" className="export-folder-change" disabled={busy} onClick={() => void onChangePlace()}>
          Другая папка
        </button>
      )}
      {place === undefined ? null : <span className="export-folder-place">Папка: {place}</span>}
      {note === undefined ? null : (
        <span className={failed ? "export-folder-note is-error" : "export-folder-note"} role="status">
          {note}
        </span>
      )}
    </div>
  );
}
