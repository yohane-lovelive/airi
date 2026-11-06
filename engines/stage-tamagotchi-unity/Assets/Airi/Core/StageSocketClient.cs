using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Airi.Stage.Core
{
    /// <summary>
    /// Owns the localhost WebSocket connection to Electron main.
    ///
    /// Threads:
    /// - The receive loop and the send loop run on the thread pool.
    /// - The Unity main thread calls <see cref="TryReceive"/> and <see cref="Send"/> once each
    ///   frame. Neither call blocks, so the socket cannot stall a rendered frame.
    ///
    /// Lifecycle:
    /// - One instance serves one connection. It does not reconnect, because the host owns the
    ///   lifetime of the sidecar and a lost host means that the sidecar must exit.
    /// - <see cref="IsClosed"/> changes once, from false to true, and stays true.
    /// </summary>
    public sealed class StageSocketClient : IDisposable
    {
        private const int ReceiveBufferBytes = 16 * 1024;

        private readonly ClientWebSocket _socket = new ClientWebSocket();
        private readonly CancellationTokenSource _lifetime = new CancellationTokenSource();
        private readonly ConcurrentQueue<string> _inbound = new ConcurrentQueue<string>();
        private readonly ConcurrentQueue<string> _outbound = new ConcurrentQueue<string>();
        private readonly SemaphoreSlim _outboundSignal = new SemaphoreSlim(0);

        private int _closed;
        private string _closeReason;

        /// <summary>True after the connection ended, for any reason.</summary>
        public bool IsClosed => Volatile.Read(ref _closed) == 1;

        /// <summary>Why the connection ended. It is null until <see cref="IsClosed"/> is true.</summary>
        public string CloseReason => Volatile.Read(ref _closeReason);

        /// <summary>
        /// Connects and starts the two loops.
        ///
        /// Throws:
        /// - The error of the connection when Electron main does not accept it.
        /// </summary>
        public async Task ConnectAsync(Uri url, CancellationToken cancellation)
        {
            await _socket.ConnectAsync(url, cancellation).ConfigureAwait(false);

            _ = Task.Run(ReceiveLoopAsync);
            _ = Task.Run(SendLoopAsync);
        }

        /// <summary>Gets the next received message, if one is waiting.</summary>
        public bool TryReceive(out string message)
        {
            return _inbound.TryDequeue(out message);
        }

        /// <summary>
        /// Queues one message. After the connection ends, the message is dropped, because nobody
        /// can read it.
        /// </summary>
        public void Send(string message)
        {
            if (IsClosed)
            {
                return;
            }

            _outbound.Enqueue(message);
            _outboundSignal.Release();
        }

        /// <summary>Ends the connection and stops both loops. It does not wait for the host.</summary>
        public void Dispose()
        {
            MarkClosed("The sidecar closed the connection.");
            _lifetime.Cancel();
            _socket.Dispose();
        }

        private async Task ReceiveLoopAsync()
        {
            var buffer = new ArraySegment<byte>(new byte[ReceiveBufferBytes]);
            var message = new MemoryStream();

            try
            {
                while (!_lifetime.IsCancellationRequested)
                {
                    WebSocketReceiveResult result = await _socket
                        .ReceiveAsync(buffer, _lifetime.Token)
                        .ConfigureAwait(false);

                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        MarkClosed($"The host closed the connection ({result.CloseStatus}).");
                        return;
                    }

                    message.Write(buffer.Array, buffer.Offset, result.Count);

                    // A large message arrives in several parts. Only the last part ends it.
                    if (result.EndOfMessage)
                    {
                        _inbound.Enqueue(Encoding.UTF8.GetString(
                            message.GetBuffer(),
                            0,
                            (int)message.Length));
                        message.SetLength(0);
                    }
                }
            }
            catch (Exception error)
            {
                // The runtimes throw different types for a lost connection, and this loop cannot
                // continue after any of them. So each failure counts as the end of the connection.
                MarkClosed($"The connection ended: {error.Message}");
            }
        }

        private async Task SendLoopAsync()
        {
            try
            {
                while (!_lifetime.IsCancellationRequested)
                {
                    await _outboundSignal.WaitAsync(_lifetime.Token).ConfigureAwait(false);

                    if (!_outbound.TryDequeue(out string message))
                    {
                        continue;
                    }

                    // ClientWebSocket allows one send at a time, so only this loop sends.
                    await _socket.SendAsync(
                        new ArraySegment<byte>(Encoding.UTF8.GetBytes(message)),
                        WebSocketMessageType.Text,
                        true,
                        _lifetime.Token).ConfigureAwait(false);
                }
            }
            catch (Exception error)
            {
                MarkClosed($"The connection ended: {error.Message}");
            }
        }

        private void MarkClosed(string reason)
        {
            // The two loops and Dispose can all end the connection. The first reason stays.
            if (Interlocked.CompareExchange(ref _closeReason, reason, null) == null)
            {
                Volatile.Write(ref _closed, 1);
            }
        }
    }
}
