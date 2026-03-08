export function ErrorState({ title = "Something went wrong", message }: { title?: string; message: string }) {
  return (
    <div className="state-box danger">
      <h4>{title}</h4>
      <p>{message}</p>
    </div>
  );
}
