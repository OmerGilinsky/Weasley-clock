import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:geolocator/geolocator.dart';
import 'dart:async';
import 'login_screen.dart';

class UserOptionsScreen extends StatefulWidget {
  final String userEmail;

  const UserOptionsScreen({Key? key, required this.userEmail}) : super(key: key);

  @override
  State<UserOptionsScreen> createState() => _UserOptionsScreenState();
}

class _UserOptionsScreenState extends State<UserOptionsScreen> {
  String? _selectedLocation;
  String? _gpsLocation;
  static const double _proximityRadiusMeters = 10;
  Timer? _proximityTimer;
  bool _isCheckingProximity = false;

  @override
  void initState() {
    super.initState();
    _ensureLocationPermissionAndStartChecks();
  }

  @override
  void dispose() {
    _proximityTimer?.cancel();
    super.dispose();
  }

  Future<void> _ensureLocationPermissionAndStartChecks() async {
    final serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      return;
    }

    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }

    if (permission == LocationPermission.denied ||
        permission == LocationPermission.deniedForever) {
      return;
    }

    _proximityTimer?.cancel();
    _checkAndUpdateNearbyLocation();
    _proximityTimer = Timer.periodic(
      const Duration(seconds: 20),
      (_) => _checkAndUpdateNearbyLocation(),
    );
  }

  Future<void> _checkAndUpdateNearbyLocation() async {
    if (_isCheckingProximity) {
      return;
    }

    final currentUser = FirebaseAuth.instance.currentUser;
    if (currentUser == null) {
      return;
    }

    _isCheckingProximity = true;
    try {
      final userRef = FirebaseFirestore.instance
          .collection('users')
          .doc(currentUser.uid);
      final userSnapshot = await userRef.get();
      final userData = userSnapshot.data();
      if (userData == null) {
        return;
      }

      final savedLocations = userData['location'];
      if (savedLocations is! Map<String, dynamic> || savedLocations.isEmpty) {
        return;
      }

      final position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.best,
        ),
      );

      String? nearestLocation;
      double? nearestDistance;

      for (final entry in savedLocations.entries) {
        final locationName = entry.key;
        final locationData = entry.value;
        if (locationData is! Map<String, dynamic>) {
          continue;
        }

        final latitude = (locationData['latitude'] as num?)?.toDouble();
        final longitude = (locationData['longitude'] as num?)?.toDouble();
        if (latitude == null || longitude == null) {
          continue;
        }

        final distance = Geolocator.distanceBetween(
          position.latitude,
          position.longitude,
          latitude,
          longitude,
        );

        if (distance <= _proximityRadiusMeters &&
            (nearestDistance == null || distance < nearestDistance)) {
          nearestDistance = distance;
          nearestLocation = locationName;
        }
      }

      if (nearestLocation == null) {
        return;
      }

      final currentLocation = userData['currentLocation'] as String?;
      if (currentLocation == nearestLocation) {
        return;
      }

      await userRef.set({
        'currentLocation': nearestLocation,
        'lastUpdated': FieldValue.serverTimestamp(),
      }, SetOptions(merge: true));
    } catch (_) {
      // Ignore transient location/Firebase failures; periodic checks continue.
    } finally {
      _isCheckingProximity = false;
    }
  }

  Stream<QuerySnapshot<Map<String, dynamic>>> _promptStreamForCurrentUser() {
    final currentUser = FirebaseAuth.instance.currentUser;
    if (currentUser == null) {
      return const Stream.empty();
    }

    return FirebaseFirestore.instance
        .collection('prompts')
        .where('targetUserId', isEqualTo: currentUser.uid)
        .snapshots();
  }

  Future<void> _markPromptAsRead(String promptId) async {
    await FirebaseFirestore.instance.collection('prompts').doc(promptId).set({
      'isRead': true,
      'status': 'read',
      'readAt': FieldValue.serverTimestamp(),
    }, SetOptions(merge: true));
  }

  Widget _buildPromptInbox() {
    final currentUser = FirebaseAuth.instance.currentUser;
    if (currentUser == null) {
      return const SizedBox.shrink();
    }

    return Expanded(
      child: Card(
        margin: const EdgeInsets.only(top: 20),
        child: Padding(
          padding: const EdgeInsets.all(12.0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Prompt Inbox',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              Expanded(
                child: StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
                  stream: _promptStreamForCurrentUser(),
                  builder: (context, snapshot) {
                    if (snapshot.hasError) {
                      return const Center(
                        child: Text('Failed to load prompts.'),
                      );
                    }

                    if (!snapshot.hasData) {
                      return const Center(child: CircularProgressIndicator());
                    }

                    final docs = [...snapshot.data!.docs];
                    docs.sort((a, b) {
                      final aTs = a.data()['scheduledFor'] as Timestamp?;
                      final bTs = b.data()['scheduledFor'] as Timestamp?;
                      if (aTs == null && bTs == null) {
                        return 0;
                      }
                      if (aTs == null) {
                        return 1;
                      }
                      if (bTs == null) {
                        return -1;
                      }
                      return bTs.compareTo(aTs);
                    });

                    if (docs.isEmpty) {
                      return const Center(
                        child: Text('No prompts yet.'),
                      );
                    }

                    final now = DateTime.now();

                    return ListView.separated(
                      itemCount: docs.length,
                      separatorBuilder: (_, __) => const Divider(height: 1),
                      itemBuilder: (context, index) {
                        final doc = docs[index];
                        final data = doc.data();
                        final text = (data['promptText'] as String?)?.trim();
                        final senderName =
                            (data['createdByEmail'] as String?) ?? 'Unknown';
                        final isRead = data['isRead'] == true;
                        final scheduledForTs = data['scheduledFor'] as Timestamp?;
                        final scheduledFor = scheduledForTs?.toDate();
                        final isDue =
                            scheduledFor == null || !scheduledFor.isAfter(now);
                        final timeLabel = scheduledFor == null
                            ? 'Now'
                            : TimeOfDay.fromDateTime(scheduledFor)
                                .format(context);

                        return ListTile(
                          contentPadding: EdgeInsets.zero,
                          title: Text(
                            text == null || text.isEmpty ? '(No text)' : text,
                          ),
                          subtitle: Text(
                            isDue
                                ? 'From $senderName · $timeLabel'
                                : 'Scheduled for $timeLabel · From $senderName',
                          ),
                          trailing: !isRead && isDue
                              ? TextButton(
                                  onPressed: () => _markPromptAsRead(doc.id),
                                  child: const Text('Mark Read'),
                                )
                              : Icon(
                                  isRead
                                      ? Icons.check_circle
                                      : Icons.schedule,
                                  color: isRead
                                      ? Colors.green
                                      : Theme.of(context)
                                          .colorScheme
                                          .secondary,
                                ),
                        );
                      },
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _updateLocation() {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Update Location'),
        content: const Text('Location updated successfully!'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }

  void _sendGreeting() {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Send Greeting'),
        content: const Text('Greeting sent successfully!'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }

  void _setGpsLocation() {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Set GPS Location'),
        content: const Text('GPS location set successfully!'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }

  void _logout() {
    FirebaseAuth.instance.signOut();
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (context) => const LoginScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('User Options'),
        centerTitle: true,
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: _logout,
            tooltip: 'Logout',
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(24.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Welcome, ${widget.userEmail}',
              style: Theme.of(context).textTheme.titleLarge,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 40),
            Text(
              'User Options',
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            const SizedBox(height: 20),
            ElevatedButton.icon(
              onPressed: _updateLocation,
              icon: const Icon(Icons.location_on),
              label: const Text('Update Location'),
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: _sendGreeting,
              icon: const Icon(Icons.mail),
              label: const Text('Send Greeting'),
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
            ),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: _setGpsLocation,
              icon: const Icon(Icons.gps_fixed),
              label: const Text('Set GPS Location'),
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
              ),
            ),
            _buildPromptInbox(),
          ],
        ),
      ),
    );
  }
}
