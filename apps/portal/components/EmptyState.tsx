export function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="state-box">
      <h4>{title}</h4>
      <p>{message}</p>
    </div>
  );
}
