import socket, time, sys

host = '209.145.60.79'
port = 5038
username = 'connectcommsgefenw'
password = '8457823075Tty!'

s = socket.socket()
s.settimeout(8)
s.connect((host, port))
data = s.recv(1024).decode()
print('Greeting:', repr(data))

login = (
    f'Action: Login\r\n'
    f'Username: {username}\r\n'
    f'Secret: {password}\r\n'
    f'Events: on\r\n'
    f'ActionID: test1\r\n'
    f'\r\n'
)
s.send(login.encode())
time.sleep(3)

resp = b''
try:
    s.settimeout(3)
    while True:
        chunk = s.recv(4096)
        if not chunk:
            break
        resp += chunk
except socket.timeout:
    pass

print('Response:', repr(resp.decode()))
s.close()
